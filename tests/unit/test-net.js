// SPDX-License-Identifier: MIT
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

// One run sends four requests to one host at the same time: two boundary files and two feeds.
test('a session sends four requests to one host at the same time', async () => {
    const routes = Object.fromEntries(['/1', '/2', '/3', '/4'].map(p => [p, {body: '{}', delayMs: 300}]));
    const {server, base, session} = setup(routes);
    await Promise.all(Object.keys(routes).map(p => getJson(session, base + p)));
    assertEqual(server.maxWaiting, 4);
    server.stop();
});

await run();
