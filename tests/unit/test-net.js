// SPDX-License-Identifier: MIT
import {test, run, assertEqual, assertDeepEqual, assertRejects} from '../lib/assert.js';
import {startServer} from '../lib/fixture-server.js';
import {createSession, getJson, apiBase} from '../../updater/net.js';

function setup(routes) {
    const server = startServer(routes);
    return {server, base: server.base, session: createSession({timeout: 5})};
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
    await assertRejects(getJson(session, base + '/503'), /^HTTP 503$/);
    server.stop();
});

test('slow server times out', async () => {
    const server = startServer({'/slow': {body: '{}', delayMs: 2000}});
    const session = createSession({timeout: 1});
    await assertRejects(getJson(session, server.base + '/slow'), /^Network timeout$/);
    server.stop();
});

test('html body is a failed request', async () => {
    const {server, base, session} = setup({'/h': {body: '<html>login</html>'}});
    await assertRejects(getJson(session, base + '/h'), /^Invalid JSON$/);
    server.stop();
});

await run();
