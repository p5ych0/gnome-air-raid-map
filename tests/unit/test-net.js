// SPDX-License-Identifier: MIT
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {test, run, assertEqual, assertDeepEqual, assertTrue} from '../lib/assert.js';
import {startServer} from '../lib/fixture-server.js';
import {createSession, getJson, apiBase, RequestError} from '../../updater/net.js';

function setup(routes) {
    const server = startServer(routes);
    return {server, base: server.base, session: createSession({timeout: 5})};
}

// The caller classifies every request failure by its type, so each one must be a RequestError.
async function assertRequestError(promise, pattern) {
    try {
        await promise;
    } catch (e) {
        assertTrue(e instanceof RequestError, `expected a RequestError, got ${e}`);
        assertTrue(pattern.test(e.message), `message ${JSON.stringify(e.message)} does not match ${pattern}`);
        return;
    }
    throw new Error('expected the promise to reject');
}

test('api base has no trailing slash', () => assertEqual(apiBase().endsWith('/'), false));

test('200 returns json and etag', async () => {
    const {server, base, session} = setup({'/a': {body: '{"a":1}', etag: 'W/"x"'}});
    assertDeepEqual(await getJson(session, base + '/a'), {status: 200, json: {a: 1}, etag: 'W/"x"'});
    server.stop();
});

test('matching etag returns 304', async () => {
    const {server, base, session} = setup({'/a': {body: '{"a":1}', etag: 'W/"x"'}});
    assertDeepEqual(await getJson(session, base + '/a', {etag: 'W/"x"'}), {status: 304});
    server.stop();
});

test('server error is a failed request', async () => {
    const {server, base, session} = setup({'/503': {status: 503, body: 'down'}});
    await assertRequestError(getJson(session, base + '/503'), /^HTTP 503$/);
    server.stop();
});

test('slow server times out', async () => {
    const server = startServer({'/slow': {body: '{}', delayMs: 2000}});
    const session = createSession({timeout: 1});
    await assertRequestError(getJson(session, server.base + '/slow'), /^Network timeout$/);
    server.stop();
});

test('a slow body stops at the total deadline', async () => {
    const server = startServer({'/drip': {body: '{"a":1}', dripMs: 700}});
    const session = createSession({timeout: 5});
    const start = GLib.get_monotonic_time();
    await assertRequestError(getJson(session, server.base + '/drip', {deadlineMs: 1000}), /^Network timeout$/);
    const ms = (GLib.get_monotonic_time() - start) / 1000;
    assertTrue(ms >= 1000 && ms < 2000, `rejected after ${ms} ms`);
    server.stop();
});

test('html body is a failed request', async () => {
    const {server, base, session} = setup({'/h': {body: '<html>login</html>'}});
    await assertRequestError(getJson(session, base + '/h'), /^Invalid JSON$/);
    server.stop();
});

test('refused connection is a failed request', async () => {
    const {server, base, session} = setup({});
    server.stop();
    await assertRequestError(getJson(session, base + '/a'), /^Network error: ./);
});

test('invalid url is a failed request', async () => {
    await assertRequestError(getJson(createSession(), 'not a url'), /^Invalid URL$/);
});

// The trust store (Task 11b): GnuTLS on Fedora reads it through p11-kit, which costs about
// 60 ms of CPU in each run. An https session loads the PEM file of the system CAs instead.
const FIXTURES = GLib.build_filenamev([GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), 'fixtures']);
const TEST_CERT = GLib.build_filenamev([FIXTURES, 'test-tls-cert.pem']);
const SYSTEM_CA_FILE = '/etc/ssl/certs/ca-certificates.crt';
const NET_URL = GLib.Uri.resolve_relative(import.meta.url, '../../updater/net.js', GLib.UriFlags.NONE);
const trustStore = () => Gio.TlsBackend.get_default().get_default_database();
const anchorsOf = db => (db instanceof Gio.TlsFileDatabase ? db.anchors : null);

test('an https session uses the CA file, also for new connections', () => {
    const session = createSession({base: 'https://neptun.in.ua', anchors: TEST_CERT});
    assertEqual(anchorsOf(session.get_tls_database()), TEST_CERT);
    // glib-networking reads the default trust store of the process when it creates a connection.
    assertEqual(anchorsOf(trustStore()), TEST_CERT, 'the default trust store of the process');
});

test('the CA file is the PEM file of the system CAs', () => {
    if (!GLib.file_test(SYSTEM_CA_FILE, GLib.FileTest.EXISTS)) return;
    assertEqual(anchorsOf(createSession({base: 'https://neptun.in.ua'}).get_tls_database()), SYSTEM_CA_FILE);
});

test('an http session and a session without a usable CA file keep the trust store', () => {
    const dir = GLib.dir_make_tmp('air-raid-ca-XXXXXX');
    const empty = GLib.build_filenamev([dir, 'empty.pem']);
    try {
        GLib.file_set_contents(empty, '');
        const before = trustStore();
        for (const [base, anchors] of [['http://127.0.0.1:1', TEST_CERT],
            ['https://neptun.in.ua', GLib.build_filenamev([dir, 'missing.pem'])], ['https://neptun.in.ua', empty]]) {
            const session = createSession({base, anchors});
            assertTrue(trustStore() === before && session.get_tls_database() === before, `${base} ${anchors}`);
        }
    } finally {
        GLib.unlink(empty);
        GLib.rmdir(dir);
    }
});

// In a new process: a local TLS server with the test certificate, and one request with
// the CA file `anchors`. Prints the request result and whether the process loaded the
// p11-kit trust module (/proc/self/maps).
function tlsRequestIn(anchors) {
    const script = `
        imports.gi.versions.Soup = '3.0';
        const {GLib, Gio, Soup} = imports.gi;
        const server = new Soup.Server({tls_certificate: Gio.TlsCertificate.new_from_file(ARGV[0])});
        server.add_handler(null, (srv, msg) => {
            msg.set_status(200, null);
            msg.set_response('application/json', Soup.MemoryUse.COPY, new TextEncoder().encode('{"ok":true}'));
        });
        server.listen_local(0, Soup.ServerListenOptions.HTTPS | Soup.ServerListenOptions.IPV4_ONLY);
        const base = 'https://127.0.0.1:' + server.get_uris()[0].get_port();
        const loop = new GLib.MainLoop(null, false);
        let result;
        import(ARGV[2]).then(net => net.getJson(net.createSession({base, anchors: ARGV[1]}), base + '/a'))
            .then(r => { result = {status: r.status, json: r.json}; }, e => { result = {error: e.message}; })
            .finally(() => loop.quit());
        loop.run();
        const maps = new TextDecoder().decode(GLib.file_get_contents('/proc/self/maps')[1]);
        print(JSON.stringify({...result, p11KitTrust: maps.includes('p11-kit-trust')}));`;
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_PIPE});
    const [, stdout] = launcher.spawnv(['gjs', '-c', script, GLib.build_filenamev([FIXTURES, 'test-tls-server.pem']),
        anchors, NET_URL]).communicate_utf8(null, null);
    return JSON.parse(stdout);
}

test('a TLS request trusts the CA file and does not load the p11-kit trust store', () =>
    assertDeepEqual(tlsRequestIn(TEST_CERT), {status: 200, json: {ok: true}, p11KitTrust: false}));

test('a TLS request fails for a server that the CA file does not trust', () => {
    if (!GLib.file_test(SYSTEM_CA_FILE, GLib.FileTest.EXISTS)) return;
    const result = tlsRequestIn(SYSTEM_CA_FILE);
    assertTrue(/^Network error: .*TLS certificate/.test(result.error), `result ${JSON.stringify(result)}`);
    assertEqual(result.p11KitTrust, false, 'the p11-kit trust store is loaded');
});

// One run sends four requests to one host at the same time: two boundary files and two feeds.
test('a session sends four requests to one host at the same time', async () => {
    const routes = Object.fromEntries(['/1', '/2', '/3', '/4'].map(p => [p, {body: '{}', delayMs: 300}]));
    const {server, base, session} = setup(routes);
    await Promise.all(Object.keys(routes).map(p => getJson(session, base + p)));
    assertEqual(server.maxWaiting, 4);
    server.stop();
});

await run();
