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

// Every failure of getJson. The caller counts it as a failed request (spec 5.4,
// step 4), not as a run error.
export class RequestError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RequestError';
    }
}

// The session timeout is an idle timeout: a server that sends a byte now and
// then never hits it. deadlineMs limits the whole request (spec 5.4).
export async function getJson(session, url, {etag = null, deadlineMs = 15000} = {}) {
    const msg = Soup.Message.new('GET', url);
    if (!msg) throw new RequestError('Invalid URL');
    if (etag) msg.get_request_headers().append('If-None-Match', etag);
    const cancellable = new Gio.Cancellable();
    let expired = false;
    const deadline = GLib.timeout_add(GLib.PRIORITY_DEFAULT, deadlineMs, () => {
        expired = true;
        cancellable.cancel();
        return GLib.SOURCE_REMOVE;
    });
    let bytes;
    try {
        bytes = await session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable);
    } catch (e) {
        if (expired || (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT)))
            throw new RequestError('Network timeout');
        throw new RequestError(`Network error: ${e && e.message !== undefined ? e.message : e}`);
    } finally {
        if (!expired) GLib.source_remove(deadline);
    }
    const status = msg.get_status();
    if (status === 304) return {status: 304};
    if (status !== 200) throw new RequestError(`HTTP ${status}`);
    const responseEtag = msg.get_response_headers().get_one('ETag');
    let json;
    try {
        json = JSON.parse(new TextDecoder().decode(bytes.toArray()));
    } catch (e) {
        throw new RequestError('Invalid JSON');
    }
    return {status: 200, json, etag: responseEtag};
}
