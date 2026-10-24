// SPDX-License-Identifier: MIT
// Local HTTP server for tests. As a script:
//   gjs -m tests/lib/fixture-server.js <port> <dir>
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import System from 'system';

export function startServer(routes) {
    const table = new Map(Object.entries(routes));
    const hits = new Map();
    // 304 answers to a matching If-None-Match, per path.
    const notModified = new Map();
    // Delayed requests that wait for an answer now, and the most at one time.
    let waiting = 0, maxWaiting = 0;
    const server = new Soup.Server();
    server.add_handler(null, (srv, msg, path) => {
        hits.set(path, (hits.get(path) || 0) + 1);
        let route = table.get(path);
        if (typeof route === 'function') route = route(path);
        if (!route) {
            msg.set_status(404, null);
            return;
        }
        const {status = 200, body = '', etag = null, delayMs = 0, dripMs = 0} = route;
        const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
        if (dripMs) {
            drip(msg, status, bytes, dripMs);
            return;
        }
        const respond = () => {
            const inm = msg.get_request_headers().get_one('If-None-Match');
            const headers = msg.get_response_headers();
            if (etag) headers.replace('ETag', etag);
            if (etag && inm === etag) {
                notModified.set(path, (notModified.get(path) || 0) + 1);
                msg.set_status(304, null);
            } else {
                msg.set_status(status, null);
                msg.set_response('application/json', Soup.MemoryUse.COPY, bytes);
            }
        };
        if (!delayMs) {
            respond();
            return;
        }
        msg.pause();
        maxWaiting = Math.max(maxWaiting, ++waiting);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            --waiting;
            respond();
            msg.unpause();
            return GLib.SOURCE_REMOVE;
        });
    });
    const port = arguments_port();
    server.listen_local(port, Soup.ServerListenOptions.IPV4_ONLY);
    const uri = server.get_uris()[0];
    return {
        base: `http://127.0.0.1:${uri.get_port()}`,
        hits,
        notModified,
        get maxWaiting() {
            return maxWaiting;
        },
        setRoute(path, route) {
            table.set(path, route);
        },
        stop() {
            server.disconnect();
        },
    };
}

// Sends the body one byte every dripMs milliseconds. The connection is never
// idle for long, so only a total deadline stops the request. The drip stops
// when the client goes away.
function drip(msg, status, bytes, dripMs) {
    msg.set_status(status, null);
    msg.get_response_headers().set_encoding(Soup.Encoding.CHUNKED);
    const out = msg.get_response_body();
    let sent = 0, gone = false;
    const handler = msg.connect('disconnected', () => {
        gone = true;
    });
    msg.pause();
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, dripMs, () => {
        if (!gone) {
            out.append(bytes.slice(sent, sent + 1));
            if (++sent >= bytes.length) out.complete();
            msg.unpause();
        }
        if (!gone && sent < bytes.length) return GLib.SOURCE_CONTINUE;
        // A handler left connected would run during garbage collection at exit.
        msg.disconnect(handler);
        return GLib.SOURCE_REMOVE;
    });
}

let requestedPort = 0;
function arguments_port() {
    const p = requestedPort;
    requestedPort = 0;
    return p;
}

function readFile(path) {
    return GLib.file_get_contents(path)[1];
}

function serveDirectory(port, dir) {
    const file = name => GLib.build_filenamev([dir, name]);
    let flip = false;
    requestedPort = port;
    // Keep the handle until the loop ends: without a reference, the garbage
    // collector frees the Soup.Server, and the port closes after some requests.
    const server = startServer({
        '/oblasts.geojson': () => ({body: readFile(file('oblasts.geojson'))}),
        '/raions.geojson': () => ({body: readFile(file('raions.geojson'))}),
        '/api/v1/threats': () => ({body: readFile(file('threats.json'))}),
        '/api/v1/alerts': () => {
            flip = !flip;
            return {body: readFile(file(flip ? 'alerts-a.json' : 'alerts-b.json'))};
        },
    });
    GLib.MainLoop.new(null, false).run();
    server.stop();
}

if (System.programInvocationName.endsWith('fixture-server.js')) {
    const [port, dir] = System.programArgs;
    if (!port || !dir) {
        printerr('usage: fixture-server.js <port> <dir>');
        System.exit(2);
    }
    serveDirectory(Number(port), dir);
}
