// SPDX-License-Identifier: MIT
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {test, run, assertEqual, assertDeepEqual, assertTrue, assertRejects} from '../lib/assert.js';
import {removeTree} from '../lib/files.js';
import {startServer} from '../lib/fixture-server.js';
import {createSession} from '../../updater/net.js';
import {loadGeometry, readJson, writeJsonAtomic} from '../../updater/store.js';

const STORE_URL = GLib.Uri.resolve_relative(import.meta.url, '../../updater/store.js', GLib.UriFlags.NONE);

// GJS reads some XDG folders when it starts, so appPaths runs in a new process
// with the given environment (null removes a variable).
function appPathsWith(env) {
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_PIPE});
    for (const [name, value] of Object.entries(env)) {
        if (value === null) launcher.unsetenv(name);
        else launcher.setenv(name, value, true);
    }
    const script = `import('${STORE_URL}').then(m => m.appPaths())
        .then(paths => print(JSON.stringify(paths)), e => print(JSON.stringify({error: e.message})))`;
    const [, stdout] = launcher.spawnv(['gjs', '-c', script]).communicate_utf8(null, null);
    return JSON.parse(stdout);
}

test('app paths come from the XDG variables', () => assertDeepEqual(appPathsWith({
    XDG_RUNTIME_DIR: '/x/run', XDG_CACHE_HOME: '/x/cache', XDG_STATE_HOME: '/x/state', XDG_DATA_HOME: '/x/data',
}), {
    runtimeDir: '/x/run/gnome-air-raid-map',
    cacheDir: '/x/cache/gnome-air-raid-map',
    stateDir: '/x/state/gnome-air-raid-map',
    dataDir: '/x/data/gnome-air-raid-map',
    statePath: '/x/run/gnome-air-raid-map/state.json',
}));

test('missing XDG_RUNTIME_DIR is an error', () =>
    assertDeepEqual(appPathsWith({XDG_RUNTIME_DIR: null}), {error: 'XDG_RUNTIME_DIR is not set'}));

function square(key, prop, name) {
    return {type: 'Feature', properties: {key, [prop]: name}, geometry: {
        type: 'Polygon', coordinates: [[[29, 49], [31, 49], [31, 51], [29, 51], [29, 49]]]}};
}
const collection = (prop, key) =>
    JSON.stringify({type: 'FeatureCollection', features: [square(key, prop, 'Test')]});
const sha256 = text => GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, text, -1);
// The version of each boundary file is the SHA-256 of its text.
const version = (oblasts = 'o1', raions = 'r1') =>
    `${sha256(collection('region', oblasts))}|${sha256(collection('rayon', raions))}`;

// Runs fn with a fixture server and a new cache folder. Stops the server and
// deletes the folder when fn is done, also when it fails.
async function withFixture(fn) {
    const server = startServer({
        '/oblasts.geojson': {body: collection('region', 'o1'), etag: '"o1"'},
        '/raions.geojson': {body: collection('rayon', 'r1'), etag: '"r1"'},
    });
    const dir = GLib.dir_make_tmp('air-raid-store-XXXXXX');
    try {
        await fn({server, dir, session: createSession({timeout: 5})});
    } finally {
        server.stop();
        removeTree(dir);
    }
}
const path = (dir, name) => GLib.build_filenamev([dir, name]);

test('first load downloads and caches', () => withFixture(async ({server, dir, session}) => {
    const result = await loadGeometry(session, server.base, dir, 1000000);
    assertEqual(server.hits.get('/oblasts.geojson'), 1);
    assertEqual(server.hits.get('/raions.geojson'), 1);
    assertTrue(GLib.file_test(path(dir, 'oblasts.geojson'), GLib.FileTest.EXISTS));
    assertTrue(GLib.file_test(path(dir, 'raions.geojson'), GLib.FileTest.EXISTS));
    assertEqual(result.version, version());
    assertEqual(result.geometry.oblasts.regions[0].key, 'o1');
}));

test('fresh cache makes no request', () => withFixture(async ({server, dir, session}) => {
    await loadGeometry(session, server.base, dir, 1000000);
    const result = await loadGeometry(session, server.base, dir, 1060000);
    assertEqual(server.hits.get('/oblasts.geojson'), 1);
    assertEqual(server.hits.get('/raions.geojson'), 1);
    assertEqual(result.version, version());
}));

test('old cache revalidates with etag', () => withFixture(async ({server, dir, session}) => {
    await loadGeometry(session, server.base, dir, 1000000);
    const before = readJson(path(dir, 'oblasts.geojson'), null);
    const later = 1000000 + 3600001;
    const result = await loadGeometry(session, server.base, dir, later);
    assertEqual(server.hits.get('/oblasts.geojson'), 2);
    assertEqual(server.notModified.get('/oblasts.geojson'), 1);
    assertEqual(server.notModified.get('/raions.geojson'), 1);
    assertDeepEqual(readJson(path(dir, 'oblasts.geojson'), null), before);
    assertEqual(readJson(path(dir, 'geometry.json'), null).oblasts.checkedAt, later);
    assertEqual(result.version, version());
}));

test('changed server copy is downloaded', () => withFixture(async ({server, dir, session}) => {
    await loadGeometry(session, server.base, dir, 1000000);
    server.setRoute('/oblasts.geojson', {body: collection('region', 'o2'), etag: '"o2"'});
    const result = await loadGeometry(session, server.base, dir, 1000000 + 3600001);
    assertEqual(result.version, version('o2'));
    assertEqual(result.geometry.oblasts.regions[0].key, 'o2');
    assertEqual(readJson(path(dir, 'oblasts.geojson'), null).features[0].properties.key, 'o2');
}));

test('corrupt cache is downloaded again', () => withFixture(async ({server, dir, session}) => {
    await loadGeometry(session, server.base, dir, 1000000);
    const file = path(dir, 'oblasts.geojson');
    const [, data] = GLib.file_get_contents(file);
    GLib.file_set_contents(file, data.slice(0, 20));
    const result = await loadGeometry(session, server.base, dir, 1060000);
    assertEqual(server.hits.get('/oblasts.geojson'), 2);
    assertEqual(result.geometry.oblasts.regions[0].key, 'o1');
    assertDeepEqual(readJson(file, null), JSON.parse(collection('region', 'o1')));
}));

test('304 without a known etag keeps the cache', () => withFixture(async ({server, dir, session}) => {
    await loadGeometry(session, server.base, dir, 1000000);
    GLib.unlink(path(dir, 'geometry.json'));
    server.setRoute('/oblasts.geojson', {status: 304});
    server.setRoute('/raions.geojson', {status: 304});
    const result = await loadGeometry(session, server.base, dir, 1060000);
    assertEqual(server.hits.get('/oblasts.geojson'), 2);
    assertEqual(result.geometry.oblasts.regions[0].key, 'o1');
    assertEqual(result.geometry.raions.regions[0].key, 'r1');
}));

test('boundaries load at the same time', () => withFixture(async ({server, dir, session}) => {
    server.setRoute('/oblasts.geojson', {body: collection('region', 'o1'), etag: '"o1"', delayMs: 300});
    server.setRoute('/raions.geojson', {body: collection('rayon', 'r1'), etag: '"r1"', delayMs: 300});
    const result = await loadGeometry(session, server.base, dir, 1000000);
    assertEqual(server.maxWaiting, 2);
    assertEqual(result.version, version());
}));

test('offline with valid cache uses the cache', () => withFixture(async ({server, dir, session}) => {
    await loadGeometry(session, server.base, dir, 1000000);
    server.stop();
    const result = await loadGeometry(session, server.base, dir, 1000000 + 7200000);
    assertEqual(result.geometry.raions.regions[0].key, 'r1');
    assertEqual(result.version, version());
}));

// Boundary routes without an ETag, like the directory fixture server.
function withoutEtags(server) {
    server.setRoute('/oblasts.geojson', {body: collection('region', 'o1')});
    server.setRoute('/raions.geojson', {body: collection('rayon', 'r1')});
}
test('without etags changed content changes the version', () => withFixture(async ({server, dir, session}) => {
    withoutEtags(server);
    const first = await loadGeometry(session, server.base, dir, 1000000);
    server.setRoute('/oblasts.geojson', {body: collection('region', 'o2')});
    const changed = await loadGeometry(session, server.base, dir, 1000000 + 3600001);
    assertEqual(server.hits.get('/oblasts.geojson'), 2);
    assertEqual(changed.geometry.oblasts.regions[0].key, 'o2');
    assertTrue(changed.version !== first.version, 'changed content keeps the version');
    assertEqual(first.version, version());
}));

test('without etags the same content keeps the version', () => withFixture(async ({server, dir, session}) => {
    withoutEtags(server);
    const first = await loadGeometry(session, server.base, dir, 1000000);
    const again = await loadGeometry(session, server.base, dir, 1000000 + 3600001);
    assertEqual(server.hits.get('/oblasts.geojson'), 2);
    assertEqual(again.version, first.version);
}));

test('without etags a fresh cache returns the version of the cached file', () => withFixture(async ({server, dir, session}) => {
    withoutEtags(server);
    const first = await loadGeometry(session, server.base, dir, 1000000);
    const result = await loadGeometry(session, server.base, dir, 1060000);
    assertEqual(server.hits.get('/oblasts.geojson'), 1);
    // The metadata only revalidates; it holds no version.
    assertDeepEqual(readJson(path(dir, 'geometry.json'), null).oblasts, {etag: '', checkedAt: 1000000});
    assertEqual(result.version, version());
    assertEqual(result.version, first.version);
}));

test('the version comes from the cached file, not from the metadata', () => withFixture(async ({server, dir, session}) => {
    const first = await loadGeometry(session, server.base, dir, 1000000);
    // The file changes after the metadata was written for the old content.
    GLib.file_set_contents(path(dir, 'oblasts.geojson'), collection('region', 'o2'));
    server.stop();
    const result = await loadGeometry(session, server.base, dir, 1060000);
    assertEqual(result.geometry.oblasts.regions[0].key, 'o2');
    assertEqual(result.version, version('o2'));
    assertTrue(result.version !== first.version, 'the changed file keeps the old version');
}));

test('304 to a request without an etag does not renew the cache time', () => withFixture(async ({server, dir, session}) => {
    withoutEtags(server);
    await loadGeometry(session, server.base, dir, 1000000);
    server.setRoute('/oblasts.geojson', {status: 304});
    server.setRoute('/raions.geojson', {status: 304});
    const later = 1000000 + 3600001;
    const result = await loadGeometry(session, server.base, dir, later);
    assertEqual(server.hits.get('/oblasts.geojson'), 2);
    assertEqual(result.geometry.oblasts.regions[0].key, 'o1');
    assertEqual(readJson(path(dir, 'geometry.json'), null).oblasts.checkedAt, 1000000);
    await loadGeometry(session, server.base, dir, later + 60000);
    assertEqual(server.hits.get('/oblasts.geojson'), 3, 'the next load does not request again');
}));

test('metadata entries hold only the etag and the check time', () => withFixture(async ({server, dir, session}) => {
    await loadGeometry(session, server.base, dir, 1000000);
    // A file of an older format: extra fields, one stale entry (revalidated) and one fresh entry (kept).
    writeJsonAtomic(path(dir, 'geometry.json'), {
        oblasts: {etag: '"o1"', checkedAt: 1000000, version: 'old'},
        raions: {etag: '"r1"', checkedAt: 4990000, version: 'old'},
    });
    await loadGeometry(session, server.base, dir, 5000000);
    assertEqual(server.hits.get('/oblasts.geojson'), 2);
    assertEqual(server.hits.get('/raions.geojson'), 1);
    assertDeepEqual(readJson(path(dir, 'geometry.json'), null), {
        oblasts: {etag: '"o1"', checkedAt: 5000000},
        raions: {etag: '"r1"', checkedAt: 4990000},
    });
}));

test('offline without cache rejects', () => withFixture(async ({server, dir, session}) => {
    server.stop();
    await assertRejects(loadGeometry(session, server.base, dir, 1000000));
}));

test('atomic json round trip', () => {
    const dir = GLib.dir_make_tmp('air-raid-json-XXXXXX');
    try {
        const file = path(dir, 'sub/x.json');
        writeJsonAtomic(file, {a: [1, 2], b: 'c'});
        assertDeepEqual(readJson(file, null), {a: [1, 2], b: 'c'});
        assertDeepEqual(readJson(path(dir, 'missing.json'), 'fb'), 'fb');
    } finally {
        removeTree(dir);
    }
});

await run();
