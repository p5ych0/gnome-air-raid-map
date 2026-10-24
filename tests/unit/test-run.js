// SPDX-License-Identifier: MIT
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import {test, run, assertEqual, assertDeepEqual, assertTrue, assertRejects} from '../lib/assert.js';
import {removeTree} from '../lib/files.js';
import {startServer} from '../lib/fixture-server.js';
import {syntheticCollection, syntheticGeometry, syntheticThreats} from '../lib/fixtures.js';
import {assertColorNear, pixelReaderFromPath} from '../lib/pixels.js';
import {parseDisplayOverride} from '../../core/layout.js';
import {project} from '../../core/mapdata.js';
import {mapTransform, toScreen} from '../../core/render.js';
import {createSession} from '../../updater/net.js';
import {readJson} from '../../updater/store.js';
import {runOnce} from '../../updater/run.js';
import {KEYS, applyLive} from '../../updater/wallpaper.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const now = Date.UTC(2026, 9, 23, 14, 5, 30);
const SCHEMA = 'org.gnome.desktop.background';
const MAIN = GLib.Uri.resolve_relative(import.meta.url, '../../updater/main.js', GLib.UriFlags.NONE);
const ALERTS = {oblasts: [{key: 'test'}], raions: []};
const THREATS = {threats: syntheticThreats()};
const GEOJSON = JSON.stringify(syntheticCollection());

const routes = () => ({
    '/oblasts.geojson': {body: GEOJSON, etag: '"o1"'},
    '/raions.geojson': {body: GEOJSON, etag: '"r1"'},
    '/api/v1/alerts': {body: JSON.stringify(ALERTS)},
    '/api/v1/threats': {body: JSON.stringify(THREATS)},
});

const display = text => () => parseDisplayOverride(text);
const noDisplay = () => {
    throw new Error('Mutter is not running');
};

// Runs fn with a fixture server, a new temporary folder and settings in memory.
// once(options) is one run with the values of main.js; options replace any of them.
async function withRun(fn, serverRoutes = routes()) {
    const server = startServer(serverRoutes);
    const dir = GLib.dir_make_tmp('air-raid-run-XXXXXX');
    const backend = Gio.memory_settings_backend_new();
    const settings = Gio.Settings.new_with_backend(SCHEMA, backend);
    const runtimeDir = `${dir}/run/gnome-air-raid-map`;
    const paths = {runtimeDir, cacheDir: `${dir}/cache/gnome-air-raid-map`, statePath: `${runtimeDir}/state.json`};
    const session = createSession({timeout: 5});
    const once = (options = {}) => runOnce({
        session, settings, display: display('1920x1080@1'), paths, now, base: server.base,
        labelMode: 'updated', reloadMethod: 'rename', pictureOptions: 'spanned', ...options,
    });
    try {
        await fn({server, dir, backend, settings, paths, once});
    } finally {
        server.stop();
        removeTree(dir);
    }
}

const pathOf = uri => GLib.filename_from_uri(uri)[0];
const exists = uri => GLib.file_test(pathOf(uri), GLib.FileTest.EXISTS);
// The URI of the picture file picture-<ms>.png in the runtime folder.
const pictureUri = (paths, ms) => GLib.filename_to_uri(`${paths.runtimeDir}/picture-${ms}.png`, null);

function pictureSize(uri) {
    const [format, width, height] = GdkPixbuf.Pixbuf.get_file_info(pathOf(uri));
    assertTrue(format !== null, `${uri} is not a picture`);
    return [width, height];
}

// Returns (x, y) -> [r, g, b] for the PNG at uri.
const readPicture = uri => pixelReaderFromPath(pathOf(uri));

// A point inside the synthetic square, away from the threat symbols, at 1920x1080.
const INSIDE = toScreen(mapTransform(syntheticGeometry().oblasts.bounds, 1920, 1080), project([24, 45]))
    .map(Math.round);

const near = (pixel, hex, tolerance) => {
    try {
        assertColorNear(pixel, hex, tolerance);
        return true;
    } catch (e) {
        return false;
    }
};

// The centered loading message ("Завантаження мапи…") is drawn in #f2c879.
function hasLoadingMessage(read) {
    for (let y = 520; y < 560; ++y)
        for (let x = 760; x < 1160; ++x)
            if (near(read(x, y), '#f2c879', 20)) return true;
    return false;
}

// Points the wallpaper to uri, as another program does (not through the settings
// object of the updater). The failure unit does this with gsettings.
function setWallpaper(backend, uri, options) {
    const other = Gio.Settings.new_with_backend(SCHEMA, backend);
    other.delay();
    other.set_string('picture-uri', uri);
    other.set_string('picture-uri-dark', uri);
    other.set_string('picture-options', options);
    other.apply();
}

const showBanner = backend => setWallpaper(backend, 'file:///banner.png', 'centered');

// Runs the main loop until pending signals (for example, settings changes) are emitted.
function flushEvents() {
    const context = GLib.MainContext.default();
    while (context.iteration(false));
}

test('first run draws and sets the wallpaper', () => withRun(async ({paths, settings, once}) => {
    const result = await once();
    assertEqual(result.drew, true);
    // The Shell never showed this file name, so it has no old copy of it.
    assertEqual(result.uri, pictureUri(paths, now));
    assertEqual(settings.get_string('picture-uri'), result.uri);
    assertEqual(settings.get_string('picture-uri-dark'), result.uri);
    assertEqual(settings.get_string('picture-options'), 'spanned');
    assertDeepEqual(pictureSize(result.uri), [1920, 1080]);
    assertColorNear(readPicture(result.uri)(...INSIDE), '#cf4655');
    assertDeepEqual(result.warnings, []);
    const state = readJson(paths.statePath, null);
    assertEqual(state.version, 1);
    assertDeepEqual(state.alerts.payload, ALERTS);
    assertEqual(state.alerts.lastSuccess, now);
    assertDeepEqual(state.threats.payload, THREATS);
    assertEqual(state.picture, pathOf(result.uri));
    assertEqual(state.layout.width, 1920);
    assertDeepEqual(state.displayState, parseDisplayOverride('1920x1080@1'));
    assertTrue(typeof state.renderKey === 'string' && state.renderKey.length > 0, 'no render key');
}));

test('same minute same data does not draw', () => withRun(async ({once}) => {
    const first = await once();
    const second = await once({now: now + 20000});
    assertEqual(second.drew, false);
    assertEqual(second.uri, first.uri);
}));

test('a new minute draws again under the same file name', () => withRun(async ({once}) => {
    const first = await once();
    const second = await once({now: now + 60000});
    assertEqual(second.drew, true);
    // The Shell watches the file that it shows and loads it again after the rename.
    assertEqual(second.uri, first.uri);
}));

test('a missing picture is drawn again', () => withRun(async ({once}) => {
    const first = await once();
    Gio.File.new_for_uri(first.uri).delete(null);
    const second = await once({now: now + 20000});
    assertEqual(second.drew, true);
    assertDeepEqual(pictureSize(second.uri), [1920, 1080]);
}));

// While the banner shows, the Shell does not watch the live file and can keep an old
// copy of it. So the live picture comes back under a new file name, and the old file
// is deleted (docs/decisions/2026-10-23-picture-reload-method.md).
test('failure banner is replaced by the live picture under a new file name', () =>
    withRun(async ({backend, paths, settings, once}) => {
        const first = await once();
        showBanner(backend);
        assertEqual(settings.get_string('picture-uri'), 'file:///banner.png');
        const second = await once({now: now + 20000});
        assertEqual(second.drew, false, 'the same data is not drawn again');
        assertEqual(second.uri, pictureUri(paths, now + 20000));
        assertEqual(settings.get_string('picture-uri'), second.uri);
        assertEqual(settings.get_string('picture-uri-dark'), second.uri);
        assertEqual(settings.get_string('picture-options'), 'spanned');
        assertColorNear(readPicture(second.uri)(...INSIDE), '#cf4655');
        assertTrue(!exists(first.uri), 'the old file is deleted');
        assertEqual(readJson(paths.statePath, null).picture, pathOf(second.uri));
        assertDeepEqual(second.warnings, []);
    }));

test('new data after the failure banner is drawn under a new file name', () =>
    withRun(async ({server, backend, paths, settings, once}) => {
        const first = await once();
        showBanner(backend);
        server.setRoute('/api/v1/alerts', {body: JSON.stringify({oblasts: [], raions: []})});
        const second = await once({now: now + 20000});
        assertEqual(second.drew, true);
        assertEqual(second.uri, pictureUri(paths, now + 20000));
        assertEqual(settings.get_string('picture-uri'), second.uri);
        assertColorNear(readPicture(second.uri)(...INSIDE), '#223448');
        assertTrue(!exists(first.uri), 'the old file is deleted');
    }));

test('a new file name is never the name of an existing file', () =>
    withRun(async ({backend, paths, settings, once}) => {
        const first = await once();
        showBanner(backend);
        const second = await once();
        assertEqual(second.uri, GLib.filename_to_uri(`${paths.runtimeDir}/picture-${now}-1.png`, null));
        assertEqual(settings.get_string('picture-uri'), second.uri);
        assertTrue(exists(second.uri), 'the new file exists');
        assertTrue(!exists(first.uri), 'the old file is deleted');
    }));

test('a picture path outside the runtime folder in the state file is not used', () =>
    withRun(async ({dir, backend, paths, once}) => {
        await once();
        const outside = `${dir}/outside.png`;
        GLib.file_set_contents(outside, 'not ours');
        const state = readJson(paths.statePath, null);
        GLib.file_set_contents(paths.statePath, JSON.stringify({...state, picture: outside}));
        setWallpaper(backend, GLib.filename_to_uri(outside, null), 'spanned');
        const second = await once({now: now + 20000});
        assertEqual(second.drew, true);
        assertEqual(second.uri, pictureUri(paths, now + 20000));
        assertTrue(GLib.file_test(outside, GLib.FileTest.EXISTS), 'a file outside the folder is not deleted');
    }));

test('threat outage draws stale threats and exits normally', () => withRun(async ({server, paths, once}) => {
    await once();
    server.setRoute('/api/v1/threats', {status: 503, body: 'down'});
    const second = await once({now: now + 20000});
    assertEqual(second.drew, true);
    assertDeepEqual(second.warnings, ['threats: HTTP 503']);
    const state = readJson(paths.statePath, null);
    assertEqual(state.threats.error, 'HTTP 503');
    assertDeepEqual(state.threats.payload, THREATS, 'the last valid threats are kept');
    assertEqual(state.threats.lastSuccess, now);
    assertEqual(state.alerts.error, '');
    assertEqual(state.alerts.lastSuccess, now + 20000);
}));

test('invalid alerts keep the last valid alerts', () => withRun(async ({server, paths, once}) => {
    await once();
    server.setRoute('/api/v1/alerts', {body: JSON.stringify({oblasts: [{key: 'elsewhere'}], raions: []})});
    const second = await once({now: now + 20000});
    assertEqual(second.drew, true);
    const state = readJson(paths.statePath, null);
    assertEqual(state.alerts.error, 'Alert region missing from map boundaries');
    assertDeepEqual(state.alerts.payload, ALERTS);
}));

test('display failure uses the last layout', () => withRun(async ({once}) => {
    await once();
    const second = await once({display: noDisplay, now: now + 60000});
    assertEqual(second.drew, true);
    assertDeepEqual(pictureSize(second.uri), [1920, 1080]);
}));

test('no layout at all is a run error', () => withRun(async ({server, paths, settings, once}) => {
    await assertRejects(once({display: noDisplay}), /monitor layout/);
    assertEqual(server.hits.size, 0, 'no request without a layout');
    assertTrue(!GLib.file_test(paths.statePath, GLib.FileTest.EXISTS), 'no state file');
    assertEqual(settings.get_string('picture-options'), 'zoom', 'the wallpaper is not changed');
}));

test('layout change draws a new picture', () => withRun(async ({paths, once}) => {
    await once();
    const second = await once({display: display('1080x1920@1'), now: now + 20000});
    assertEqual(second.drew, true);
    assertDeepEqual(pictureSize(second.uri), [1080, 1920]);
    assertEqual(readJson(paths.statePath, null).layout.height, 1920);
}));

// Ruling: a failed boundary load is never a run error. Without boundaries the picture
// shows the loading message; the alerts are checked only for their shape.
for (const [name, route] of [
    ['a boundary outage', {status: 503, body: 'down'}],
    ['invalid boundaries', {body: JSON.stringify({type: 'FeatureCollection', features: []})}],
]) {
    test(`loading picture after ${name} without a cache`, () => withRun(async ({paths, once}) => {
        const result = await once();
        assertEqual(result.drew, true);
        const read = readPicture(result.uri);
        assertColorNear(read(...INSIDE), '#0e1722');
        assertTrue(hasLoadingMessage(read), 'no loading message');
        // Without boundaries no alerts response is accepted (core/view.js acceptAlerts).
        assertTrue(result.warnings.length === 2 && result.warnings[0].startsWith('boundaries: ') &&
            result.warnings[1] === 'alerts: Boundaries unavailable',
            `warnings: ${JSON.stringify(result.warnings)}`);
        const state = readJson(paths.statePath, null);
        assertEqual(state.alerts.error, 'Boundaries unavailable');
        assertEqual(state.alerts.payload, null);
    }, {...routes(), '/oblasts.geojson': route}));
}

test('boundaries come back after an outage', () => withRun(async ({server, once}) => {
    const loading = await once();
    assertTrue(hasLoadingMessage(readPicture(loading.uri)), 'no loading message');
    server.setRoute('/oblasts.geojson', {body: GEOJSON, etag: '"o1"'});
    const second = await once({now: now + 20000});
    assertEqual(second.drew, true);
    assertColorNear(readPicture(second.uri)(...INSIDE), '#cf4655');
}, {...routes(), '/oblasts.geojson': {status: 503, body: 'down'}}));

test('boundaries and both feeds are requested at the same time', () => withRun(async ({server, once}) => {
    for (const [path, route] of Object.entries(routes()))
        server.setRoute(path, {...route, delayMs: 300});
    const result = await once();
    assertEqual(server.maxWaiting, 4);
    assertEqual(result.drew, true);
}));

test('applyLive writes the keys that differ in one change', () => {
    assertDeepEqual(KEYS, ['picture-uri', 'picture-uri-dark', 'picture-options', 'primary-color']);
    const backend = Gio.memory_settings_backend_new();
    const settings = Gio.Settings.new_with_backend(SCHEMA, backend);
    const watcher = Gio.Settings.new_with_backend(SCHEMA, backend);
    const color = watcher.get_string('primary-color');
    const changes = [];
    const handler = watcher.connect('change-event', (_settings, keys) => {
        changes.push(keys.map(key => GLib.quark_to_string(key)).sort());
        return false;
    });
    try {
        assertEqual(applyLive(settings, 'file:///p.png'), true);
        flushEvents();
        assertDeepEqual(changes, [['picture-options', 'picture-uri', 'picture-uri-dark']]);
        assertEqual(watcher.get_string('picture-uri-dark'), 'file:///p.png');
        assertEqual(watcher.get_string('picture-options'), 'spanned');
        assertEqual(watcher.get_string('primary-color'), color);
        assertEqual(applyLive(settings, 'file:///p.png'), false);
        watcher.set_string('picture-options', 'centered');
        flushEvents();
        changes.length = 0;
        assertEqual(applyLive(settings, 'file:///p.png', 'zoom'), true);
        flushEvents();
        assertDeepEqual(changes, [['picture-options']]);
        assertEqual(watcher.get_string('picture-options'), 'zoom');
    } finally {
        watcher.disconnect(handler);
    }
});

// Settings whose keys are all locked: the keyfile backend writes only below its
// root path. A read-only folder would not lock them for root (the GNOME images).
function lockedSettings(dir) {
    const backend = Gio.keyfile_settings_backend_new(`${dir}/settings.ini`, '/org/other/', null);
    return Gio.Settings.new_with_backend(SCHEMA, backend);
}

async function assertLocked(promise) {
    await assertRejects(promise, /^Cannot set the wallpaper: picture-uri is not writable$/);
}

test('applyLive throws when a key is locked', () => withRun(async ({dir}) => {
    const settings = lockedSettings(dir);
    await assertLocked((async () => applyLive(settings, 'file:///p.png'))());
    assertEqual(settings.get_string('picture-options'), 'zoom');
}));

test('a locked wallpaper is a run error', () => withRun(async ({dir, once}) => {
    await assertLocked(once({settings: lockedSettings(dir)}));
}));

const runtimeFiles = paths => {
    const names = [];
    const e = Gio.File.new_for_path(paths.runtimeDir).enumerate_children('standard::name', 0, null);
    for (let i = e.next_file(null); i; i = e.next_file(null)) names.push(i.get_name());
    return names.sort();
};
const pictureFiles = paths => runtimeFiles(paths).filter(n => n.startsWith('picture'));

test('a locked wallpaper leaves at most two pictures and no temporary file in many runs', () =>
    withRun(async ({dir, paths, once}) => {
        const settings = lockedSettings(dir);
        for (let n = 0; n < 5; n++) {
            await assertLocked(once({settings, now: now + n * 60000}));
            const files = pictureFiles(paths);
            assertTrue(files.length <= 2, `run ${n}: ${files.join(' ')}`);
            assertEqual(files.filter(f => f.endsWith('.tmp')).length, 0);
        }
    }));

test('leftovers of a killed run are removed', () => withRun(async ({paths, settings, once}) => {
    GLib.mkdir_with_parents(paths.runtimeDir, 0o700);
    for (const name of ['picture-111.png', 'picture-222.png.tmp', 'picture-333.png'])
        GLib.file_set_contents(`${paths.runtimeDir}/${name}`, 'x');
    const result = await once();
    assertDeepEqual(pictureFiles(paths), [`picture-${now}.png`]);
    assertEqual(settings.get_string('picture-uri'), result.uri);
}));

test('the picture that the settings show survives a run that cannot apply', () =>
    withRun(async ({dir, paths, once}) => {
        GLib.mkdir_with_parents(paths.runtimeDir, 0o700);
        const old = `${paths.runtimeDir}/picture-111.png`;
        GLib.file_set_contents(old, 'x');
        GLib.file_set_contents(`${paths.runtimeDir}/picture-222.png`, 'x');
        const seen = {
            get_string: key => key === 'picture-options' ? 'zoom' : GLib.filename_to_uri(old, null),
            is_writable: key => key !== 'picture-uri',
            delay() {}, set_string() {}, apply() {},
        };
        await assertLocked(once({settings: seen}));
        assertTrue(GLib.file_test(old, GLib.FileTest.EXISTS), 'the picture on screen was deleted');
        assertTrue(pictureFiles(paths).length <= 2, pictureFiles(paths).join(' '));
    }));

// Runs argv in a new process; env sets its variables (null removes one).
async function spawn(argv, env) {
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    });
    for (const [name, value] of Object.entries(env)) {
        if (value === null) launcher.unsetenv(name);
        else launcher.setenv(name, value, true);
    }
    const process = launcher.spawnv(argv);
    const [stdout, stderr] = await process.communicate_utf8_async(null, null);
    return {status: process.get_exit_status(), stdout, stderr};
}

// main.js runs in a new process.
const runMain = env => spawn(['gjs', '-m', pathOf(MAIN)], env);

// The variables of main.js for a run in dir against the fixture server.
const mainEnv = (dir, server) => ({
    XDG_RUNTIME_DIR: `${dir}/run`, XDG_CACHE_HOME: `${dir}/cache`, XDG_STATE_HOME: `${dir}/state`,
    XDG_DATA_HOME: `${dir}/data`, GSETTINGS_BACKEND: 'memory', AIR_RAID_MAP_DISPLAY: '1280x720@1',
    AIR_RAID_MAP_API_BASE: server.base, AIR_RAID_MAP_LABEL_MODE: null, AIR_RAID_MAP_PICTURE_OPTIONS: null,
});

test('main runs once and exits 0', () => withRun(async ({server, dir}) => {
    const result = await runMain(mainEnv(dir, server));
    assertDeepEqual(result, {status: 0, stdout: '', stderr: ''});
    const picture = readJson(`${dir}/run/gnome-air-raid-map/state.json`, null).picture;
    assertTrue(/^picture-\d+\.png$/.test(GLib.path_get_basename(picture)), `picture: ${picture}`);
    assertDeepEqual(pictureSize(GLib.filename_to_uri(picture, null)), [1280, 720]);
    assertEqual(server.hits.get('/api/v1/alerts'), 1);
}));

// GIO sends a GVfs metadata call for Gio.File.move and Gio.File.delete, and
// gvfsd-metadata then writes $XDG_DATA_HOME/gvfs-metadata on the home disk. The
// picture is in RAM so that repeated writes do not wear the disk (spec 5.5), so a
// run renames and deletes its files with rename(2) and unlink(2). The check needs
// a session bus with GVfs: dbus-run-session starts one, and a probe with
// Gio.File.move shows whether GVfs writes metadata on this machine.
test('runs write no GVfs metadata', () => withRun(async ({server, dir}) => {
    const inSession = argv => ['dbus-run-session', '--', ...argv];
    if (!GLib.find_program_in_path('dbus-run-session')) {
        print('# skip: no dbus-run-session, so no GVfs metadata check');
        return;
    }
    GLib.mkdir_with_parents(`${dir}/probe`, 0o700);
    GLib.file_set_contents(`${dir}/probe/a`, 'a');
    await spawn(inSession(['gjs', '-c', `const Gio = imports.gi.Gio;
        Gio.File.new_for_path(ARGV[0]).move(Gio.File.new_for_path(ARGV[1]), Gio.FileCopyFlags.NONE, null, null);`,
    `${dir}/probe/a`, `${dir}/probe/b`]), {XDG_DATA_HOME: `${dir}/probe-data`});
    if (!GLib.file_test(`${dir}/probe-data/gvfs-metadata`, GLib.FileTest.IS_DIR)) {
        print('# skip: GVfs writes no metadata here (no GVfs, or no session bus)');
        return;
    }
    // Run 1 draws. Run 2 starts with the default settings (memory backend), so it
    // puts the live picture back under a new name and deletes the old file.
    const env = mainEnv(dir, server);
    for (const n of [1, 2]) {
        const result = await spawn(inSession(['gjs', '-m', pathOf(MAIN)]), env);
        assertEqual(result.status, 0, `run ${n}: ${result.stderr}`);
    }
    assertTrue(!GLib.file_test(`${dir}/data/gvfs-metadata`, GLib.FileTest.EXISTS), 'GVfs wrote metadata');
    const files = [];
    const children = Gio.File.new_for_path(`${dir}/run/gnome-air-raid-map`).enumerate_children(
        'standard::name', Gio.FileQueryInfoFlags.NONE, null);
    for (let info = children.next_file(null); info; info = children.next_file(null))
        files.push(info.get_name());
    assertDeepEqual(files.filter(name => name !== 'state.json').length, 1, `files: ${files}`);
}));

// A damaged state file, or a state file of another version, gives the start state:
// the run is a first run. damage(state) gives the text of the state file.
for (const [name, damage] of [
    ['a state file that is not JSON', () => '{"version": 1, "alerts": {"payload"'],
    ['a state file with values of the wrong type', () => JSON.stringify({version: 1,
        alerts: 'x', threats: [1], displayState: 'x', renderKey: 7, picture: {}})],
    ['a state file of another version', state => JSON.stringify({...state, version: 2})],
]) {
    test(`${name} gives a first run`, () => withRun(async ({paths, settings, once}) => {
        await once();
        GLib.file_set_contents(paths.statePath, damage(readJson(paths.statePath, null)));
        // With the saved state, the same data in the same minute is not drawn again.
        const second = await once({now: now + 20000});
        assertEqual(second.drew, true);
        assertDeepEqual(second.warnings, []);
        assertEqual(settings.get_string('picture-uri'), second.uri);
        assertColorNear(readPicture(second.uri)(...INSIDE), '#cf4655');
        const state = readJson(paths.statePath, null);
        assertEqual(state.version, 1);
        assertEqual(state.alerts.lastSuccess, now + 20000);
        assertEqual(state.picture, pathOf(second.uri));
    }));

    test(`main exits 0 and draws after ${name}`, () => withRun(async ({server, dir}) => {
        const statePath = `${dir}/run/gnome-air-raid-map/state.json`;
        GLib.mkdir_with_parents(GLib.path_get_dirname(statePath), 0o700);
        GLib.file_set_contents(statePath, damage({version: 1, renderKey: 'old', picture: `${dir}/old.png`}));
        const result = await runMain(mainEnv(dir, server));
        assertDeepEqual(result, {status: 0, stdout: '', stderr: ''});
        const state = readJson(statePath, null);
        assertEqual(state.version, 1);
        assertDeepEqual(pictureSize(GLib.filename_to_uri(state.picture, null)), [1280, 720]);
    }));
}

test('main exits 1 with one line when XDG_RUNTIME_DIR is missing', async () => {
    const result = await runMain({
        XDG_RUNTIME_DIR: null, GSETTINGS_BACKEND: 'memory', AIR_RAID_MAP_DISPLAY: '1280x720@1',
        AIR_RAID_MAP_API_BASE: 'http://127.0.0.1:9',
    });
    assertEqual(result.status, 1);
    assertEqual(result.stdout, '');
    assertEqual(result.stderr, 'gnome-air-raid-map: XDG_RUNTIME_DIR is not set\n');
});

await run();
