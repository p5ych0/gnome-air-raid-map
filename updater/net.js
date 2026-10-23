// SPDX-License-Identifier: MIT
// HTTP GET with libsoup 3.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {VERSION} from './version.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const DEFAULT_BASE = 'https://neptun.in.ua';

export function apiBase() {
    const base = GLib.getenv('AIR_RAID_MAP_API_BASE') || DEFAULT_BASE;
    return base.replace(/\/+$/, '');
}

export function createSession({timeout = 15} = {}) {
    return new Soup.Session({timeout, user_agent: `gnome-air-raid-map/${VERSION}`});
}

export async function getJson(session, url, {etag = null} = {}) {
    const msg = Soup.Message.new('GET', url);
    if (!msg) throw new Error('Invalid URL');
    if (etag) msg.get_request_headers().append('If-None-Match', etag);
    let bytes;
    try {
        bytes = await session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
    } catch (e) {
        if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT))
            throw new Error('Network timeout');
        throw new Error(`Network error: ${e && e.message !== undefined ? e.message : e}`);
    }
    const status = msg.get_status();
    if (status === 304) return {status: 304};
    if (status !== 200) throw new Error(`HTTP ${status}`);
    const responseEtag = msg.get_response_headers().get_one('ETag');
    let json;
    try {
        json = JSON.parse(new TextDecoder().decode(bytes.toArray()));
    } catch (e) {
        throw new Error('Invalid JSON');
    }
    return {status: 200, json, etag: responseEtag};
}
