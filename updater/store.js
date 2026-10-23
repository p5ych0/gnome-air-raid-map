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
    const stateDir = GLib.build_filenamev([GLib.get_user_state_dir(), APP]);
    return {
        runtimeDir: GLib.build_filenamev([runtime, APP]),
        cacheDir: GLib.build_filenamev([GLib.get_user_cache_dir(), APP]),
        stateDir,
        dataDir: GLib.build_filenamev([GLib.get_user_data_dir(), APP]),
        statePath: GLib.build_filenamev([stateDir, 'state.json']),
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

export function writeJsonAtomic(path, value) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    const data = new TextEncoder().encode(JSON.stringify(value));
    Gio.File.new_for_path(path).replace_contents(
        data, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}

function loadValid(path) {
    const json = readJson(path, null);
    if (!json) return null;
    try {
        return {json, geometry: prepareGeometry(json)};
    } catch (e) {
        return null;
    }
}

async function loadOne(session, url, path, entry, now) {
    const cached = loadValid(path);
    const known = cached && entry && typeof entry.etag === 'string' ? entry : null;
    if (cached && known && typeof known.checkedAt === 'number' &&
        now - known.checkedAt >= 0 && now - known.checkedAt < MAX_CACHE_AGE_MS)
        return {geometry: cached.geometry, entry: known, changed: false};
    let result;
    try {
        result = await getJson(session, url, {etag: cached && known ? known.etag : null});
    } catch (e) {
        if (cached) return {geometry: cached.geometry, entry: known || {etag: '', checkedAt: 0}, changed: false};
        throw e;
    }
    if (result.status === 304 && cached)
        return {geometry: cached.geometry, entry: {etag: known.etag, checkedAt: now}, changed: true};
    if (result.status === 304) throw new Error('Unexpected HTTP 304');
    let geometry;
    try {
        geometry = prepareGeometry(result.json);
    } catch (e) {
        if (cached) return {geometry: cached.geometry, entry: known || {etag: '', checkedAt: 0}, changed: false};
        throw e;
    }
    writeJsonAtomic(path, result.json);
    return {geometry, entry: {etag: result.etag || '', checkedAt: now}, changed: true};
}

export async function loadGeometry(session, base, cacheDir, now) {
    const metaPath = GLib.build_filenamev([cacheDir, 'geometry.json']);
    const meta = readJson(metaPath, {}) || {};
    const oblasts = await loadOne(session, `${base}/oblasts.geojson`,
        GLib.build_filenamev([cacheDir, 'oblasts.geojson']), meta.oblasts, now);
    const raions = await loadOne(session, `${base}/raions.geojson`,
        GLib.build_filenamev([cacheDir, 'raions.geojson']), meta.raions, now);
    if (oblasts.changed || raions.changed)
        writeJsonAtomic(metaPath, {oblasts: oblasts.entry, raions: raions.entry});
    return {
        geometry: {oblasts: oblasts.geometry, raions: raions.geometry},
        version: `${oblasts.entry.etag}|${raions.entry.etag}`,
    };
}
