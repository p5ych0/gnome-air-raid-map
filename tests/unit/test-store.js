// SPDX-License-Identifier: MIT
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {test, run, assertEqual, assertDeepEqual, assertTrue, assertRejects} from '../lib/assert.js';
import {importCopy, removeTree} from '../lib/files.js';
import {startServer} from '../lib/fixture-server.js';
import {pixelReader} from '../lib/pixels.js';
import {syntheticView} from '../lib/fixtures.js';
import {prepareGeometry} from '../../core/mapdata.js';
import {pictureLayout, parseDisplayOverride} from '../../core/layout.js';
import {renderPicture} from '../../core/render.js';
import {createSession} from '../../updater/net.js';
import {loadGeometry, readJson, readPrepared, writeJsonAtomic, writePrepared} from '../../updater/store.js';

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

// The prepared boundaries (Task 11b): the projected geometry of each file, next to it,
// for the version of the file. A run then does not parse and project the GeoJSON again.
const preparedPath = (dir, name) => path(dir, `${name}.prepared`);
const otherGeometry = () => prepareGeometry(JSON.parse(collection('region', 'other')));

test('a load writes the prepared boundaries for the version of each file', () => withFixture(async ({server, dir, session}) => {
    await loadGeometry(session, server.base, dir, 1000000);
    assertDeepEqual(readPrepared(preparedPath(dir, 'oblasts'), sha256(collection('region', 'o1'))),
        prepareGeometry(JSON.parse(collection('region', 'o1'))));
    assertDeepEqual(readPrepared(preparedPath(dir, 'raions'), sha256(collection('rayon', 'r1'))),
        prepareGeometry(JSON.parse(collection('rayon', 'r1'))));
}));

test('a prepared entry for the version of the file is used', () => withFixture(async ({server, dir, session}) => {
    await loadGeometry(session, server.base, dir, 1000000);
    // A valid entry for the same version, with other content: the load must take it as it is.
    writePrepared(preparedPath(dir, 'oblasts'), otherGeometry(), sha256(collection('region', 'o1')));
    const result = await loadGeometry(session, server.base, dir, 1060000);
    assertEqual(result.geometry.oblasts.regions[0].key, 'other');
    assertEqual(result.version, version());
    assertEqual(server.hits.get('/oblasts.geojson'), 1);
}));

test('a prepared entry for another version is rebuilt', () => withFixture(async ({server, dir, session}) => {
    await loadGeometry(session, server.base, dir, 1000000);
    writePrepared(preparedPath(dir, 'oblasts'), otherGeometry(), sha256(collection('region', 'old')));
    const result = await loadGeometry(session, server.base, dir, 1060000);
    assertEqual(result.geometry.oblasts.regions[0].key, 'o1');
    assertDeepEqual(readPrepared(preparedPath(dir, 'oblasts'), sha256(collection('region', 'o1'))),
        prepareGeometry(JSON.parse(collection('region', 'o1'))), 'the entry is not rebuilt');
}));

test('a changed boundary file rebuilds its prepared entry', () => withFixture(async ({server, dir, session}) => {
    await loadGeometry(session, server.base, dir, 1000000);
    GLib.file_set_contents(path(dir, 'oblasts.geojson'), collection('region', 'o2'));
    const result = await loadGeometry(session, server.base, dir, 1060000);
    assertEqual(result.geometry.oblasts.regions[0].key, 'o2');
    assertTrue(readPrepared(preparedPath(dir, 'oblasts'), sha256(collection('region', 'o2'))),
        'no prepared entry for the new version');
}));

// The header and the doubles of the prepared entry at file. writeEntry writes them back
// with a valid checksum, in the layout of updater/store.js: the doubles in the byte order
// entry.littleEndian.
const NATIVE_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
function readEntry(file) {
    const [, bytes] = GLib.file_get_contents(file);
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(64, true);
    const start = Math.ceil((68 + size) / 8) * 8;
    return {header: JSON.parse(new TextDecoder().decode(bytes.subarray(68, 68 + size))),
        numbers: Array.from(new Float64Array(bytes.slice(start).buffer)), littleEndian: NATIVE_LITTLE_ENDIAN};
}
function writeEntry(file, {header, numbers, littleEndian}) {
    const text = new TextEncoder().encode(JSON.stringify(header));
    const start = Math.ceil((68 + text.length) / 8) * 8;
    const bytes = new Uint8Array(start + 8 * numbers.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(64, text.length, true);
    bytes.set(text, 68);
    numbers.forEach((n, i) => view.setFloat64(start + 8 * i, n, littleEndian));
    bytes.set(new TextEncoder().encode(GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, bytes.subarray(64))));
    GLib.file_set_contents(file, bytes);
}

// The entry holds the output of the rules of core/mapdata.js, so its header holds the
// SHA-256 of the text of that file. An entry from other code is not used.
const MAPDATA = GLib.filename_from_uri(
    GLib.Uri.resolve_relative(import.meta.url, '../../core/mapdata.js', GLib.UriFlags.NONE))[0];
const codeVersion = () => sha256(new TextDecoder().decode(GLib.file_get_contents(MAPDATA)[1]));

test('a prepared entry holds the SHA-256 of core/mapdata.js', () => withFixture(async ({server, dir, session}) => {
    await loadGeometry(session, server.base, dir, 1000000);
    for (const name of ['oblasts', 'raions'])
        assertEqual(readEntry(preparedPath(dir, name)).header.code, codeVersion(), name);
}));

test('a prepared entry from other code is rebuilt', () => withFixture(async ({server, dir, session}) => {
    await loadGeometry(session, server.base, dir, 1000000);
    // A valid entry for the version of the file, with other content and another code version.
    const file = preparedPath(dir, 'oblasts');
    writePrepared(file, otherGeometry(), sha256(collection('region', 'o1')), 'other code');
    const result = await loadGeometry(session, server.base, dir, 1060000);
    assertDeepEqual(result.geometry.oblasts, prepareGeometry(JSON.parse(collection('region', 'o1'))));
    assertEqual(result.version, version());
    assertEqual(readEntry(file).header.code, codeVersion(), 'the entry is not rebuilt');
}));

test('a prepared entry without a code version is rebuilt', () => withFixture(async ({server, dir, session}) => {
    await loadGeometry(session, server.base, dir, 1000000);
    // The header of the first entries had no code field.
    const file = preparedPath(dir, 'oblasts');
    writePrepared(file, otherGeometry(), sha256(collection('region', 'o1')));
    const entry = readEntry(file);
    delete entry.header.code;
    writeEntry(file, entry);
    const result = await loadGeometry(session, server.base, dir, 1060000);
    assertDeepEqual(result.geometry.oblasts, prepareGeometry(JSON.parse(collection('region', 'o1'))));
    assertEqual(result.version, version());
    assertEqual(readEntry(file).header.code, codeVersion(), 'the entry is not rebuilt');
}));

test('without the code version a load neither uses nor writes a prepared entry', () =>
    withFixture(async ({server, dir, session}) => {
        const {module: copy, folder} = await importCopy('updater/store.js');
        try {
            // The copy cannot read its core/mapdata.js, so it has no code version.
            GLib.unlink(GLib.build_filenamev([folder, 'core', 'mapdata.js']));
            const first = await copy.loadGeometry(session, server.base, dir, 1000000);
            assertDeepEqual(first.geometry.oblasts, prepareGeometry(JSON.parse(collection('region', 'o1'))));
            assertEqual(first.version, version());
            for (const name of ['oblasts', 'raions'])
                assertTrue(!GLib.file_test(preparedPath(dir, name), GLib.FileTest.EXISTS), `${name}.prepared is written`);
            // A valid entry with other content: the copy must not use it or write over it.
            const file = preparedPath(dir, 'oblasts');
            writePrepared(file, otherGeometry(), sha256(collection('region', 'o1')));
            const again = await copy.loadGeometry(session, server.base, dir, 1060000);
            assertDeepEqual(again.geometry.oblasts, prepareGeometry(JSON.parse(collection('region', 'o1'))));
            assertDeepEqual(readPrepared(file, sha256(collection('region', 'o1'))), otherGeometry(),
                'the entry is written');
        } finally {
            removeTree(folder);
        }
    }));

// Each damage gives an entry that must not be used: the load rebuilds it from the file.
const changeByte = (bytes, index) => {
    const copy = bytes.slice();
    copy[index] ^= 0x01;
    return copy;
};
const DAMAGE = {
    'garbage': () => new TextEncoder().encode('not a prepared file'),
    'empty': () => new Uint8Array(0),
    'cut payload': bytes => bytes.slice(0, bytes.length - 8),
    'extra payload': bytes => {
        const longer = new Uint8Array(bytes.length + 16);
        longer.set(bytes);
        return longer;
    },
    'changed coordinate': bytes => changeByte(bytes, bytes.length - 12),
    'changed header': bytes => changeByte(bytes, 80),
    'changed checksum': bytes => changeByte(bytes, 3),
};
for (const [damage, change] of Object.entries(DAMAGE)) {
    test(`a damaged prepared entry is rebuilt: ${damage}`, () => withFixture(async ({server, dir, session}) => {
        await loadGeometry(session, server.base, dir, 1000000);
        const file = preparedPath(dir, 'raions');
        const [, bytes] = GLib.file_get_contents(file);
        GLib.file_set_contents(file, change(bytes));
        assertEqual(readPrepared(file, sha256(collection('rayon', 'r1'))), null, 'the damaged entry is read');
        const result = await loadGeometry(session, server.base, dir, 1060000);
        assertDeepEqual(result.geometry.raions, prepareGeometry(JSON.parse(collection('rayon', 'r1'))));
        assertEqual(result.version, version());
        assertTrue(readPrepared(file, sha256(collection('rayon', 'r1'))), 'the entry is not rebuilt');
    }));
}

// The checks behind the checksum: each change gives an entry with a valid checksum, but
// another format or a wrong shape. The raions entry has one region with one ring of 5 points.
test('a prepared entry that is written again with no change is used', () => withFixture(async ({server, dir, session}) => {
    await loadGeometry(session, server.base, dir, 1000000);
    const file = preparedPath(dir, 'raions');
    writeEntry(file, readEntry(file));
    assertDeepEqual(readPrepared(file, sha256(collection('rayon', 'r1'))),
        prepareGeometry(JSON.parse(collection('rayon', 'r1'))));
}));

const SHAPE = {
    'another format': entry => {
        entry.header.format = 'gnome-air-raid-map prepared geometry 0';
    },
    // The entry of a computer with the other byte order.
    'another byte order': entry => {
        entry.header.littleEndian = entry.littleEndian = !entry.littleEndian;
    },
    // A second region with the key, the label and the points of the first.
    'a duplicate key': entry => {
        entry.header.regions.push(entry.header.regions[0]);
        entry.numbers.push(...entry.numbers.slice(4));
    },
    'a ring of 3 points': entry => {
        entry.header.regions[0].rings[0][0] = 3;
        entry.numbers.splice(entry.numbers.length - 4);
    },
    'more doubles': entry => {
        entry.numbers.push(0, 0);
    },
    'fewer doubles': entry => {
        entry.numbers.splice(entry.numbers.length - 2);
    },
    // The reader must stop before it makes the points of such a ring.
    'a ring longer than all doubles': entry => {
        entry.header.regions[0].rings[0][0] = 2 ** 31 - 1;
    },
    // The numbers that prepareGeometry rejects: the first 4 doubles are the bounds, the next
    // 2 are the center of the region, and the last 2 are the last point of the last ring.
    'a NaN point': entry => {
        entry.numbers[entry.numbers.length - 1] = NaN;
    },
    'an Infinity center': entry => {
        entry.numbers[4] = Infinity;
    },
    'bounds with no area': entry => {
        entry.numbers[2] = entry.numbers[0];
    },
    // The checksum is valid, but the numbers are not the output of prepareGeometry.
    // A point that project() never makes, with bounds that include it:
    'a point out of the projection range': entry => {
        entry.numbers[entry.numbers.length - 2] = 1e300;
        entry.numbers[2] = 1e300;
    },
    'a point outside the stored bounds': entry => {
        entry.numbers[entry.numbers.length - 2] = 100;
    },
    'stored bounds that differ from the extent of the points': entry => {
        entry.numbers[2] += 1;
    },
    'a center outside the bounds': entry => {
        entry.numbers[4] = 100;
    },
    // One ring in a box of 5e-324 by 5e-324, with the bounds of the box and a center in it.
    // The ring has no |area| > 1e-10, so prepareGeometry never makes it. The map scale of
    // such bounds is Infinity, and every point on the screen is NaN.
    'points in a box of width 5e-324': entry => {
        const ring = [[0, 0], [5e-324, 0], [5e-324, 5e-324], [0, 5e-324], [0, 0]];
        entry.numbers = [0, 0, 5e-324, 5e-324, 0, 0, ...ring.flat()];
    },
    // The center must be the label point that prepareGeometry computes, bit for bit.
    'a center one ulp from the label point': entry => {
        entry.numbers[4] = nextUp(entry.numbers[4]);
    },
};
// The next double above a positive x: its bits as an integer, plus one.
function nextUp(x) {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, x);
    view.setBigUint64(0, view.getBigUint64(0) + 1n);
    return view.getFloat64(0);
}
for (const [shape, change] of Object.entries(SHAPE)) {
    test(`a prepared entry with a valid checksum is rebuilt: ${shape}`, () => withFixture(async ({server, dir, session}) => {
        await loadGeometry(session, server.base, dir, 1000000);
        const file = preparedPath(dir, 'raions');
        const entry = readEntry(file);
        change(entry);
        writeEntry(file, entry);
        assertEqual(readPrepared(file, sha256(collection('rayon', 'r1'))), null, 'the entry is read');
        const result = await loadGeometry(session, server.base, dir, 1060000);
        assertDeepEqual(result.geometry.raions, prepareGeometry(JSON.parse(collection('rayon', 'r1'))));
        assertEqual(result.version, version());
        assertDeepEqual(readPrepared(file, sha256(collection('rayon', 'r1'))),
            prepareGeometry(JSON.parse(collection('rayon', 'r1'))), 'the entry is not rebuilt');
    }));
}

// prepareGeometry accepts an outer ring that crosses itself. The centroid of such a ring
// can lie outside its points. The entry must still be used, or each run rebuilds it.
test('a prepared region with a self-crossing ring and its center outside its points is used', () => {
    const dir = GLib.dir_make_tmp('air-raid-prepared-XXXXXX');
    try {
        const fresh = prepareGeometry({type: 'FeatureCollection', features: [{type: 'Feature',
            properties: {key: 'bow-tie'}, geometry: {type: 'Polygon',
                coordinates: [[[29, 49], [31, 51], [31, 49.5], [29, 50.6], [29, 49]]]}}]});
        const [x, y] = fresh.regions[0].center, b = fresh.bounds;
        assertTrue(x < b[0] || x > b[2] || y < b[1] || y > b[3], `the center ${x}, ${y} is in the bounds ${b}`);
        writePrepared(path(dir, 'x.prepared'), fresh, 'v1');
        assertDeepEqual(readPrepared(path(dir, 'x.prepared'), 'v1'), fresh);
    } finally {
        removeTree(dir);
    }
});

test('a prepared entry that cannot be written is not an error', () => withFixture(async ({server, dir, session}) => {
    // A folder in place of the file: the entry can be neither read nor written.
    GLib.mkdir_with_parents(preparedPath(dir, 'oblasts'), 0o755);
    const first = await loadGeometry(session, server.base, dir, 1000000);
    const again = await loadGeometry(session, server.base, dir, 1060000);
    for (const result of [first, again]) {
        assertEqual(result.geometry.oblasts.regions[0].key, 'o1');
        assertEqual(result.version, version());
    }
}));

// Polygons with holes, a MultiPolygon, Cyrillic labels and coordinates with many digits.
function richCollection() {
    const ring = (x0, y0, x1, y1) => [[x0, y0], [x1, y0 + 0.123456789012345], [x1, y1], [x0 + 1e-9, y1], [x0, y0]];
    return {type: 'FeatureCollection', features: [
        {properties: {key: 'київська', region: 'Київська область'}, geometry: {type: 'Polygon',
            coordinates: [ring(29.1, 49.2, 31.7, 51.3), ring(30, 50, 30.5, 50.5).reverse()]}},
        {properties: {key: 'м. київ', name: 'Київ'}, geometry: {type: 'MultiPolygon',
            coordinates: [[ring(30.2, 50.3, 30.4, 50.5)], [ring(31.9, 46.1, 33.3, 47.7), ring(32, 46.5, 32.5, 47)]]}},
        {properties: {key: 'крим', region: 'Автономна Республіка Крим'}, geometry: {type: 'Polygon',
            coordinates: [ring(32.5, 44.4, 36.6, 46.2)]}},
    ]};
}

test('prepared boundaries give the same geometry and the same picture', () => {
    const dir = GLib.dir_make_tmp('air-raid-prepared-XXXXXX');
    try {
        const fresh = prepareGeometry(richCollection());
        writePrepared(path(dir, 'x.prepared'), fresh, 'v1');
        const loaded = readPrepared(path(dir, 'x.prepared'), 'v1');
        assertDeepEqual(loaded, fresh);
        const layout = pictureLayout(parseDisplayOverride('640x360@1'));
        const pixels = geometry => {
            const surface = renderPicture(layout, {oblasts: geometry, raions: geometry}, syntheticView({
                alerts: {raions: {}, oblasts: {'@київська': 'red', '@крим': 'yellow'}, count: 2}}));
            const read = pixelReader(surface);
            surface.finish();
            return read;
        };
        const [a, b] = [pixels(fresh), pixels(loaded)];
        let differ = 0;
        for (let y = 0; y < layout.height; y++)
            for (let x = 0; x < layout.width; x++)
                if (a(x, y).some((v, i) => v !== b(x, y)[i])) ++differ;
        assertEqual(differ, 0, 'pixels that differ');
    } finally {
        removeTree(dir);
    }
});

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
