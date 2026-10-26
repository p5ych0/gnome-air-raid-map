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

// One run sends four requests to one host at the same time: two boundary files and
// two feeds. The Soup default of two connections for each host would queue two of them.
const MAX_CONNECTIONS_PER_HOST = 4;

// The PEM file of the system CAs. GnuTLS on Debian and Ubuntu uses this file as its default
// trust store. On Fedora it is the bundle that update-ca-trust extracts for TLS servers,
// and the default trust store is p11-kit, which costs about 60 ms of CPU in each run; the
// file costs about 6 ms (Task 11b).
const SYSTEM_CA_FILE = '/etc/ssl/certs/ca-certificates.crt';

// base: the API base. Only an https session loads a CA file. The file becomes the default
// trust store of the process: glib-networking reads the default trust store when it
// creates a TLS connection, before Soup gives the connection the database of the session.
// Without a usable CA file (a missing or empty file), nothing changes.
export function createSession({timeout = 15, base = '', anchors = SYSTEM_CA_FILE} = {}) {
    const session = new Soup.Session({timeout, user_agent: `gnome-air-raid-map/${VERSION}`,
        max_conns_per_host: MAX_CONNECTIONS_PER_HOST});
    if (base.startsWith('https://')) {
        let database = null;
        try {
            database = Gio.TlsFileDatabase.new(anchors);
        } catch (e) {
            // The default trust store.
        }
        if (database) {
            Gio.TlsBackend.get_default().set_default_database(database);
            session.set_tls_database(database);
        }
    }
    return session;
}

// Every failure of getJson. The caller counts it as a failed request (spec 5.4,
// step 4), not as a run error. status is the HTTP status of the answer, or 0 if
// no answer came.
export class RequestError extends Error {
    constructor(message, status = 0) {
        super(message);
        this.name = 'RequestError';
        this.status = status;
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
    if (status !== 200) throw new RequestError(`HTTP ${status}`, status);
    const responseEtag = msg.get_response_headers().get_one('ETag');
    let json;
    try {
        json = JSON.parse(new TextDecoder().decode(bytes.toArray()));
    } catch (e) {
        throw new RequestError('Invalid JSON', status);
    }
    return {status: 200, json, etag: responseEtag};
}
