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

function loadValid(path) {
    try {
        const [ok, contents] = GLib.file_get_contents(path);
        if (!ok) return null;
        const text = new TextDecoder().decode(contents);
        return {geometry: prepareGeometry(JSON.parse(text)), version: sha256(text)};
    } catch (e) {
        return null;
    }
}

// The metadata entry of a file holds only the ETag and the check time. Other fields of an
// older file are not written back.
const entryOf = known => ({etag: known.etag, checkedAt: known.checkedAt});

// Returns {geometry, version, entry, changed, warning}. warning is the error of a
// cache write that failed, the error of an invalid 200 answer, or ''.
async function loadOne(session, url, path, entry, now) {
    const cached = loadValid(path);
    const known = cached && entry && typeof entry.etag === 'string' ? entry : null;
    if (cached && known && typeof known.checkedAt === 'number' &&
        now - known.checkedAt >= 0 && now - known.checkedAt < MAX_CACHE_AGE_MS)
        return {geometry: cached.geometry, version: cached.version, entry: entryOf(known), changed: false, warning: ''};
    // The entry for the file on disk now.
    const kept = known ? entryOf(known) : {etag: '', checkedAt: 0};
    // A failed request or an invalid download keeps a valid cached file. After an
    // invalid 200 answer, the check time moves to now: the server answered, so the
    // next download comes after MAX_CACHE_AGE_MS, not at the next run. The invalid
    // answer is a warning: the cache hides it from the picture. A network error with
    // a valid cache is not a warning.
    const keepCache = (error, answered) => {
        if (!cached) throw error;
        return {geometry: cached.geometry, version: cached.version,
            entry: answered ? {etag: kept.etag, checkedAt: now} : kept, changed: answered,
            warning: answered ? error.message : ''};
    };
    let result;
    try {
        result = await getJson(session, url, {etag: cached && known ? known.etag : null});
    } catch (e) {
        return keepCache(e, e.status === 200);
    }
    // getJson sends If-None-Match only with a non-empty ETag. Any other 304 is a failed request.
    if (result.status === 304 && cached && known && known.etag)
        return {geometry: cached.geometry, version: cached.version,
            entry: {etag: known.etag, checkedAt: now}, changed: true, warning: ''};
    if (result.status === 304) return keepCache(new Error('Unexpected HTTP 304'), false);
    let geometry;
    try {
        geometry = prepareGeometry(result.json);
    } catch (e) {
        return keepCache(e, true);
    }
    const text = JSON.stringify(result.json);
    const version = sha256(text);
    try {
        writeTextAtomic(path, text);
    } catch (e) {
        // A full or read-only cache does not lose a valid download. The entry stays
        // the entry of the file on disk: the new ETag must not point to old content.
        return {geometry, version, entry: kept, changed: false, warning: e.message};
    }
    return {geometry, version, entry: {etag: result.etag || '', checkedAt: now}, changed: true, warning: ''};
}

// Returns {geometry, version, warnings}. warnings has one line for each cache
// write that failed and for each invalid 200 answer that the cache replaced; the
// boundaries are valid all the same.
export async function loadGeometry(session, base, cacheDir, now) {
    const metaPath = GLib.build_filenamev([cacheDir, 'geometry.json']);
    const meta = readJson(metaPath, {}) || {};
    const load = (name, entry) => loadOne(session, `${base}/${name}.geojson`,
        GLib.build_filenamev([cacheDir, `${name}.geojson`]), entry, now);
    // Both files load at the same time, so a slow server costs one deadline, not two.
    const [oblasts, raions] = await Promise.all([load('oblasts', meta.oblasts), load('raions', meta.raions)]);
    const warnings = [oblasts.warning, raions.warning].filter(warning => warning !== '');
    if (oblasts.changed || raions.changed) {
        try {
            writeJsonAtomic(metaPath, {oblasts: oblasts.entry, raions: raions.entry});
        } catch (e) {
            warnings.push(e.message);
        }
    }
    return {
        geometry: {oblasts: oblasts.geometry, raions: raions.geometry},
        version: `${oblasts.version}|${raions.version}`,
        warnings,
    };
}
