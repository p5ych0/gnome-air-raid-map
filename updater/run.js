// SPDX-License-Identifier: MIT
// One run of the updater (spec 5.4).
import GLib from 'gi://GLib';
import {pictureLayout} from '../core/layout.js';
import {renderPicture} from '../core/render.js';
import {acceptAlerts, acceptThreats, buildView, emptyFeed, failFeed, renderKey} from '../core/view.js';
import {getJson} from './net.js';
import {loadGeometry, readJson, writeJsonAtomic} from './store.js';
import {applyLive} from './wallpaper.js';
import {DEFAULT_RELOAD_METHOD, writePicture} from './writer.js';

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
export async function runOnce({session, settings, display, paths, now, base,
    labelMode = 'updated', reloadMethod = DEFAULT_RELOAD_METHOD, pictureOptions = 'spanned'}) {
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
    const alerts = applyResponse(state.alerts, alertsResponse,
        payload => acceptAlerts(state.alerts, payload, geometry, now));
    const threats = applyResponse(state.threats, threatsResponse,
        payload => acceptThreats(state.threats, payload, now));
    if (alerts.error) warnings.push(`alerts: ${alerts.error}`);
    if (threats.error) warnings.push(`threats: ${threats.error}`);

    const view = buildView(alerts, threats, geometry, now, labelMode);
    const key = renderKey(view, layout, geometryVersion);
    let picture = state.picture;
    const drew = key !== state.renderKey || picture === '' ||
        !GLib.file_test(picture, GLib.FileTest.IS_REGULAR);
    if (drew)
        picture = writePicture(renderPicture(layout, geometry, view), paths.runtimeDir, reloadMethod);

    // The picture is good even if the state cannot be saved; the next run then draws again.
    try {
        writeJsonAtomic(paths.statePath,
            {version: STATE_VERSION, alerts, threats, layout, displayState, renderKey: key, picture});
    } catch (e) {
        warnings.push(`state file: ${messageOf(e)}`);
    }

    const uri = GLib.filename_to_uri(picture, null);
    applyLive(settings, uri, pictureOptions);
    return {drew, uri, warnings};
}
