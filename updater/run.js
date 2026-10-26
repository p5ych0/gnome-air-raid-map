// SPDX-License-Identifier: MIT
// One run of the updater (spec 5.4).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {pictureLayout} from '../core/layout.js';
import {renderPicture} from '../core/render.js';
import {acceptAlerts, acceptThreats, buildView, emptyFeed, failFeed, renderKey} from '../core/view.js';
import {getJson} from './net.js';
import {loadGeometry, readJson, writeJsonAtomic} from './store.js';
import {applyLive, checkLive, showsPicture} from './wallpaper.js';
import {VERSION} from './version.js';
import {DEFAULT_RELOAD_METHOD, removeFile, renameFile, writePicture} from './writer.js';

const STATE_VERSION = 1;

const messageOf = e => (e && e.message !== undefined ? e.message : String(e));

const isFeed = feed => feed !== null && typeof feed === 'object' && 'payload' in feed &&
    typeof feed.lastSuccess === 'number' && typeof feed.lastChange === 'number' &&
    typeof feed.digest === 'string' && typeof feed.error === 'string';

// The state of the last run. A missing or damaged file, or a file of another
// version, gives the start state.
function readState(path) {
    const saved = readJson(path, null);
    const state = saved !== null && typeof saved === 'object' && saved.version === STATE_VERSION ? saved : {};
    return {
        alerts: isFeed(state.alerts) ? state.alerts : emptyFeed(),
        threats: isFeed(state.threats) ? state.threats : emptyFeed(),
        displayState: state.displayState ?? null,
        renderKey: typeof state.renderKey === 'string' ? state.renderKey : '',
        picture: typeof state.picture === 'string' ? state.picture : '',
    };
}

// The monitor layout now. If Mutter gives no layout, the last layout. If no
// layout was ever read, the run fails and does not guess a size (spec 5.6).
function readLayout(display, saved, warnings) {
    let error;
    try {
        const displayState = display();
        return {displayState, layout: pictureLayout(displayState)};
    } catch (e) {
        error = e;
    }
    if (saved) {
        try {
            const layout = pictureLayout(saved);
            warnings.push(`display: ${messageOf(error)}; using the last monitor layout`);
            return {displayState: saved, layout};
        } catch (e) {
            // A damaged saved layout is no layout.
        }
    }
    throw new Error(`No monitor layout: ${messageOf(error)}`);
}

// A new picture path in dir: picture-<now>.png, or picture-<now>-<n>.png if that
// file exists. GNOME Shell keeps a copy of a picture by its file name, and it does
// not watch the file while the wallpaper shows another picture (for example the
// failure banner). A name that the Shell never showed has no old copy
// (docs/decisions/2026-10-23-picture-reload-method.md).
function newPicturePath(dir, now) {
    for (let n = 0; ; n++) {
        const path = GLib.build_filenamev([dir, n === 0 ? `picture-${now}.png` : `picture-${now}-${n}.png`]);
        if (!GLib.file_test(path, GLib.FileTest.EXISTS)) return path;
    }
}

// Deletes every picture*.png, *.tmp and .goutputstream-* in dir except the paths in
// keep. A leftover comes from a run that failed or was killed. The .goutputstream-*
// files are the temporary files of the state write (GIO replace_contents). Only dir
// is touched. A file that cannot be deleted is one warning in warnings (once, also
// after two sweeps), not an error.
function sweepRuntimeDir(dir, keep, warnings) {
    let names;
    try {
        names = Gio.File.new_for_path(dir).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    } catch (e) {
        return;
    }
    try {
        for (let info = names.next_file(null); info !== null; info = names.next_file(null)) {
            const name = info.get_name();
            const path = GLib.build_filenamev([dir, name]);
            const ours = (name.startsWith('picture') && name.endsWith('.png')) || name.endsWith('.tmp') ||
                name.startsWith('.goutputstream-');
            if (!ours || keep.has(path)) continue;
            if (GLib.unlink(path) !== 0 && GLib.file_test(path, GLib.FileTest.EXISTS | GLib.FileTest.IS_SYMLINK)) {
                // The sweep at the start and the sweep at the end of a run can both fail on one file.
                const warning = `old file: cannot delete ${path}`;
                if (!warnings.includes(warning)) warnings.push(warning);
            }
        }
    } finally {
        names.close(null);
    }
}

const onScreenPath = uri => {
    try {
        return GLib.filename_from_uri(uri)[0];
    } catch (e) {
        return '';
    }
};

// A failed request or an invalid response keeps the last valid data and makes it
// stale. It is never a run error (spec 5.4, step 4).
function applyResponse(feed, settled, accept) {
    if (settled.status === 'rejected') return failFeed(feed, messageOf(settled.reason));
    // The feed requests send no If-None-Match, so a 304 is not a valid answer.
    if (settled.value.status !== 200) return failFeed(feed, `Unexpected HTTP ${settled.value.status}`);
    return accept(settled.value.json);
}

// Returns {drew, uri, warnings}. warnings has one line for each failed request and
// for each fallback; the data in the picture is then stale, but the run did its work.
// Rejects only on a run error: no monitor layout now and none in the state file, or
// an error while drawing or writing the picture or setting the wallpaper.
// version is the program version in the render key (core/view.js renderKey).
export async function runOnce({session, settings, display, paths, now, base,
    labelMode = 'updated', reloadMethod = DEFAULT_RELOAD_METHOD, pictureOptions = 'spanned', version = VERSION}) {
    const warnings = [];
    const state = readState(paths.statePath);
    // Before the requests: a run that cannot draw does not poll the server.
    const {displayState, layout} = readLayout(display, state.displayState, warnings);

    // All requests start at the same time, so the slowest request sets the network
    // time: one 15-second deadline, not two in a row (TimeoutStartSec=25s, spec 5.7).
    const [boundaries, alertsResponse, threatsResponse] = await Promise.allSettled([
        loadGeometry(session, base, paths.cacheDir, now),
        getJson(session, `${base}/api/v1/alerts`),
        getJson(session, `${base}/api/v1/threats`),
    ]);
    // Without boundaries the picture shows the loading message, and the alerts are
    // checked only for their shape. This is not a run error.
    const loaded = boundaries.status === 'fulfilled';
    const geometry = loaded ? boundaries.value.geometry : null;
    const geometryVersion = loaded ? boundaries.value.version : null;
    if (!loaded) warnings.push(`boundaries: ${messageOf(boundaries.reason)}`);
    else for (const warning of boundaries.value.warnings) warnings.push(`boundary cache: ${warning}`);
    const alerts = applyResponse(state.alerts, alertsResponse,
        payload => acceptAlerts(state.alerts, payload, geometry, now));
    const threats = applyResponse(state.threats, threatsResponse,
        payload => acceptThreats(state.threats, payload, now));
    if (alerts.error) warnings.push(`alerts: ${alerts.error}`);
    if (threats.error) warnings.push(`threats: ${threats.error}`);

    const view = buildView(alerts, threats, geometry, now, labelMode);
    const key = renderKey(view, layout, geometryVersion, version);
    // The live picture of the last run. Only a file in the runtime folder is ours.
    const dir = Gio.File.new_for_path(paths.runtimeDir).get_path();
    const previous = GLib.path_get_dirname(state.picture) === dir ? state.picture : '';
    // The picture on screen now: the sweeps keep it until the Shell has the new one.
    const onScreen = ['picture-uri', 'picture-uri-dark'].map(key => onScreenPath(settings.get_string(key)));
    const showsPrevious = previous !== '' && showsPicture(settings, GLib.filename_to_uri(previous, null));
    const drew = key !== state.renderKey || previous === '' ||
        !GLib.file_test(previous, GLib.FileTest.IS_REGULAR);
    // One key shows previous, the other key does not, and the data is the same: keep the
    // file and point the other key to it. This is safe for the Shell cache: the Shell can
    // keep an old copy of a file name only if the file changed while the Shell did not
    // watch it. The updater writes a file in place only when both keys show it, and
    // otherwise writes under a new name. So the file that a key shows still has the
    // content that the Shell has for it.
    const keepsPrevious = !showsPrevious && !drew && onScreen.includes(previous);
    const draw = name => writePicture(renderPicture(layout, geometry, view), dir, reloadMethod, name);
    let picture = previous;
    // The new file name comes before the sweep, so that the run cannot take the name of a
    // file that the sweep deletes.
    const path = showsPrevious || keepsPrevious ? '' : newPicturePath(dir, now);
    // Check the keys before the run makes, renames or deletes a file in the runtime
    // folder: a run that cannot set the wallpaper changes no file there.
    checkLive(settings, GLib.filename_to_uri(path === '' ? previous : path, null), pictureOptions);
    // Earlier runs that were killed can have left files: delete them before this run
    // makes new ones. A run that draws keeps only the files on screen: the saved picture
    // that no key shows goes too, so a write starts with the on-screen files only. A run
    // that does not draw keeps the saved picture: it renames that file, or a key shows it.
    sweepRuntimeDir(dir, new Set([...onScreen, ...(drew ? [] : [previous])].filter(p => p !== '')), warnings);
    try {
        if (showsPrevious) {
            // The Shell watches the file that it shows, so an update keeps the name.
            if (drew) picture = draw(GLib.path_get_basename(previous));
        } else if (!keepsPrevious) {
            // The wallpaper must move back to the live picture: after the failure banner,
            // at the first run, or after a change by the user. Use a new file name.
            if (drew) {
                picture = draw(GLib.path_get_basename(path));
            } else {
                renameFile(previous, path);
                picture = path;
            }
        }

        // The picture is good even if the state cannot be saved; the next run then draws again.
        try {
            writeJsonAtomic(paths.statePath,
                {version: STATE_VERSION, alerts, threats, layout, displayState, renderKey: key, picture});
        } catch (e) {
            warnings.push(`state file: ${messageOf(e)}`);
        }

        const uri = GLib.filename_to_uri(picture, null);
        applyLive(settings, uri, pictureOptions);
        // The Shell can have an old copy of the previous file: it must not show that file again.
        if (previous !== '' && previous !== picture) {
            try {
                removeFile(previous);
            } catch (e) {
                warnings.push(`old picture: ${messageOf(e)}`);
            }
        }
        return {drew, uri, warnings};
    } finally {
        // Whatever failed above, no file of this run or of a killed run stays behind.
        if (drew) sweepRuntimeDir(dir, new Set([picture, ...onScreen]), warnings);
    }
}
