// SPDX-License-Identifier: MIT
// XDG paths, atomic JSON files and the boundary cache.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {prepareGeometry} from '../core/mapdata.js';
import {getJson} from './net.js';

const APP = 'gnome-air-raid-map';
const MAX_CACHE_AGE_MS = 3600000;

export function appPaths() {
    const runtime = GLib.getenv('XDG_RUNTIME_DIR');
    if (!runtime) throw new Error('XDG_RUNTIME_DIR is not set');
    const runtimeDir = GLib.build_filenamev([runtime, APP]);
    return {
        runtimeDir,
        cacheDir: GLib.build_filenamev([GLib.get_user_cache_dir(), APP]),
        stateDir: GLib.build_filenamev([GLib.get_user_state_dir(), APP]),
        dataDir: GLib.build_filenamev([GLib.get_user_data_dir(), APP]),
        // The state file is in RAM and is deleted at logout (spec 5.5).
        statePath: GLib.build_filenamev([runtimeDir, 'state.json']),
    };
}

export function readJson(path, fallback) {
    try {
        const [ok, contents] = GLib.file_get_contents(path);
        if (!ok) return fallback;
        return JSON.parse(new TextDecoder().decode(contents));
    } catch (e) {
        return fallback;
    }
}

function writeTextAtomic(path, text) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    Gio.File.new_for_path(path).replace_contents(
        new TextEncoder().encode(text), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}

export function writeJsonAtomic(path, value) {
    writeTextAtomic(path, JSON.stringify(value));
}

// The version of a boundary file is the SHA-256 of the exact text that this run
// uses, never a value from the metadata. A metadata entry that does not match
// the file can then only cause one more download, never a wrong version.
const sha256 = text => GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, text, -1);

// The prepared entry of a boundary file: the prepareGeometry result for one version of
// the file, next to the file (<name>.prepared). With the entry, a run does not parse and
// project the GeoJSON, but it still reads, decodes and hashes the text of the file. In
// Task 11b the boundary steps of a run then took 11.5 ms of CPU time, not 17 ms: about
// 5 ms less for each run. Layout:
//   64 bytes   the SHA-256 (hex) of all bytes after it
//   4 bytes    the header length H, little-endian
//   H bytes    the header, JSON: the format, the version of the file, the code version,
//              the byte order, and for each region its key, its label and its ring lengths
//   0-7 bytes  zero, up to a multiple of 8
//   the rest   doubles: the bounds, then for each region its center and its ring points
// An entry with another format, version, code version or byte order, or a wrong checksum
// or shape, is not used: the run builds it again from the file.
const PREPARED_FORMAT = 'gnome-air-raid-map prepared geometry 1';
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const SUM = 64;
const sha256Bytes = bytes => GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, bytes);

// The entry holds the output of the rules of core/mapdata.js: the projection, the centers
// and the labels. So the code version is the SHA-256 of the text of that file, and an
// update that changes these rules rebuilds each entry. core/mapdata.js has no imports, so
// its text holds all of these rules. A process reads the file once (less than 0.1 ms).
// Without the file there is no code version: the run then neither reads nor writes an
// entry, and parses and projects the GeoJSON as before.
const MAPDATA = GLib.Uri.resolve_relative(import.meta.url, '../core/mapdata.js', GLib.UriFlags.NONE);
let codeVersionOfProcess;
function codeVersion() {
    if (codeVersionOfProcess === undefined) {
        try {
            const [ok, contents] = GLib.file_get_contents(GLib.filename_from_uri(MAPDATA)[0]);
            codeVersionOfProcess = ok ? sha256Bytes(contents) : null;
        } catch (e) {
            codeVersionOfProcess = null;
        }
    }
    return codeVersionOfProcess;
}

// The run gives no code argument. A test can give another code version.
export function writePrepared(path, geometry, version, code = codeVersion()) {
    if (!code) throw new Error('No code version for the prepared boundaries');
    let count = 4;
    for (const region of geometry.regions) {
        count += 2;
        for (const polygon of region.polygons)
            for (const ring of polygon) count += 2 * ring.length;
    }
    const numbers = new Float64Array(count);
    numbers.set(geometry.bounds);
    let k = 4;
    const regions = geometry.regions.map(region => {
        numbers[k++] = region.center[0];
        numbers[k++] = region.center[1];
        const rings = region.polygons.map(polygon => polygon.map(ring => {
            for (const point of ring) {
                numbers[k++] = point[0];
                numbers[k++] = point[1];
            }
            return ring.length;
        }));
        return {key: region.key, label: region.label, rings};
    });
    const header = new TextEncoder().encode(JSON.stringify(
        {format: PREPARED_FORMAT, version, code, littleEndian: LITTLE_ENDIAN, regions}));
    const start = Math.ceil((SUM + 4 + header.length) / 8) * 8;
    const bytes = new Uint8Array(start + numbers.byteLength);
    new DataView(bytes.buffer).setUint32(SUM, header.length, true);
    bytes.set(header, SUM + 4);
    bytes.set(new Uint8Array(numbers.buffer), start);
    bytes.set(new TextEncoder().encode(sha256Bytes(bytes.subarray(SUM))));
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    Gio.File.new_for_path(path).replace_contents(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}

// The prepareGeometry result in the entry at path, or null if the entry is missing or
// damaged, or if it is for another version or another code version.
export function readPrepared(path, version, code = codeVersion()) {
    if (!code) return null;
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok || bytes.length < SUM + 4) return null;
        if (new TextDecoder().decode(bytes.subarray(0, SUM)) !== sha256Bytes(bytes.subarray(SUM))) return null;
        const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(SUM, true);
        const start = Math.ceil((SUM + 4 + size) / 8) * 8;
        if (start > bytes.length || (bytes.length - start) % 8 !== 0) return null;
        const header = JSON.parse(new TextDecoder().decode(bytes.subarray(SUM + 4, SUM + 4 + size)));
        if (header?.format !== PREPARED_FORMAT || header.version !== version || header.code !== code ||
            header.littleEndian !== LITTLE_ENDIAN || !Array.isArray(header.regions) || !header.regions.length)
            return null;
        // A copy: the doubles need an aligned buffer.
        const numbers = new Float64Array(bytes.slice(start).buffer);
        let k = 4;
        const keys = {}, regions = [];
        const extent = [Infinity, Infinity, -Infinity, -Infinity];
        for (const {key, label, rings} of header.regions) {
            if (typeof key !== 'string' || !key || keys['@' + key] || typeof label !== 'string' ||
                !Array.isArray(rings) || !rings.length || k + 2 > numbers.length)
                return null;
            keys['@' + key] = true;
            const center = [numbers[k], numbers[k + 1]];
            if (!center.every(Number.isFinite)) return null;
            k += 2;
            const polygons = [];
            for (const lengths of rings) {
                if (!Array.isArray(lengths) || !lengths.length) return null;
                const polygon = [];
                for (const n of lengths) {
                    if (!Number.isInteger(n) || n < 4 || k + 2 * n > numbers.length) return null;
                    const ring = new Array(n);
                    for (let i = 0; i < n; i++, k += 2) {
                        if (!Number.isFinite(numbers[k]) || !Number.isFinite(numbers[k + 1])) return null;
                        ring[i] = [numbers[k], numbers[k + 1]];
                        extent[0] = Math.min(extent[0], numbers[k]);
                        extent[1] = Math.min(extent[1], numbers[k + 1]);
                        extent[2] = Math.max(extent[2], numbers[k]);
                        extent[3] = Math.max(extent[3], numbers[k + 1]);
                    }
                    polygon.push(ring);
                }
                polygons.push(polygon);
            }
            regions.push({key, label, polygons, center});
        }
        if (k !== numbers.length) return null;
        const bounds = Array.from(numbers.subarray(0, 4));
        // The checks of prepareGeometry: finite numbers and a map extent with an area.
        if (!bounds.every(Number.isFinite) || !(bounds[2] > bounds[0] && bounds[3] > bounds[1])) return null;
        // Trust no stored value. project() keeps every point within +-180 on both axes
        // (|longitude| <= 180, |latitude| < 85), and prepareGeometry takes the bounds from the
        // points. So the bounds must equal the extent of the points, lie within +-180, and
        // hold the centers. A point such as [1e300, 1] fails these checks.
        if (!bounds.every((b, i) => b === extent[i])) return null;
        if (!bounds.every(b => Math.abs(b) <= 180)) return null;
        if (!regions.every(({center: [x, y]}) => x >= bounds[0] && x <= bounds[2] && y >= bounds[1] && y <= bounds[3]))
            return null;
        return {regions, keys, bounds};
    } catch (e) {
        return null;
    }
}

// The entry only saves time: a run that cannot write it uses the geometry that it has.
function savePrepared(path, geometry, version) {
    try {
        writePrepared(path, geometry, version);
    } catch (e) {
        // The next run tries again.
    }
}

function loadValid(path, preparedPath) {
    let text;
    try {
        const [ok, contents] = GLib.file_get_contents(path);
        if (!ok) return null;
        text = new TextDecoder().decode(contents);
    } catch (e) {
        return null;
    }
    const version = sha256(text);
    const prepared = readPrepared(preparedPath, version);
    if (prepared) return {geometry: prepared, version};
    let geometry;
    try {
        geometry = prepareGeometry(JSON.parse(text));
    } catch (e) {
        return null;
    }
    savePrepared(preparedPath, geometry, version);
    return {geometry, version};
}

// The metadata entry of a file holds only the ETag and the check time. Other fields of an
// older file are not written back.
const entryOf = known => ({etag: known.etag, checkedAt: known.checkedAt});

async function loadOne(session, url, path, preparedPath, entry, now) {
    const cached = loadValid(path, preparedPath);
    const known = cached && entry && typeof entry.etag === 'string' ? entry : null;
    if (cached && known && typeof known.checkedAt === 'number' &&
        now - known.checkedAt >= 0 && now - known.checkedAt < MAX_CACHE_AGE_MS)
        return {geometry: cached.geometry, version: cached.version, entry: entryOf(known), changed: false};
    // A failed request or an invalid download keeps a valid cached file.
    const keepCache = error => {
        if (!cached) throw error;
        return {geometry: cached.geometry, version: cached.version,
            entry: known ? entryOf(known) : {etag: '', checkedAt: 0}, changed: false};
    };
    let result;
    try {
        result = await getJson(session, url, {etag: cached && known ? known.etag : null});
    } catch (e) {
        return keepCache(e);
    }
    // getJson sends If-None-Match only with a non-empty ETag. Any other 304 is a failed request.
    if (result.status === 304 && cached && known && known.etag)
        return {geometry: cached.geometry, version: cached.version,
            entry: {etag: known.etag, checkedAt: now}, changed: true};
    if (result.status === 304) return keepCache(new Error('Unexpected HTTP 304'));
    let geometry;
    try {
        geometry = prepareGeometry(result.json);
    } catch (e) {
        return keepCache(e);
    }
    const text = JSON.stringify(result.json);
    writeTextAtomic(path, text);
    const version = sha256(text);
    savePrepared(preparedPath, geometry, version);
    return {geometry, version, entry: {etag: result.etag || '', checkedAt: now}, changed: true};
}

export async function loadGeometry(session, base, cacheDir, now) {
    const metaPath = GLib.build_filenamev([cacheDir, 'geometry.json']);
    const meta = readJson(metaPath, {}) || {};
    const load = (name, entry) => loadOne(session, `${base}/${name}.geojson`,
        GLib.build_filenamev([cacheDir, `${name}.geojson`]), GLib.build_filenamev([cacheDir, `${name}.prepared`]),
        entry, now);
    // Both files load at the same time, so a slow server costs one deadline, not two.
    const [oblasts, raions] = await Promise.all([load('oblasts', meta.oblasts), load('raions', meta.raions)]);
    if (oblasts.changed || raions.changed)
        writeJsonAtomic(metaPath, {oblasts: oblasts.entry, raions: raions.entry});
    return {
        geometry: {oblasts: oblasts.geometry, raions: raions.geometry},
        version: `${oblasts.version}|${raions.version}`,
    };
}
