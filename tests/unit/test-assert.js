// SPDX-License-Identifier: MIT
import GLib from 'gi://GLib';
import {test, run, assertEqual, assertDeepEqual, assertTrue, assertThrows, assertRejects} from '../lib/assert.js';

test('assertDeepEqual ignores object key order', () => {
    assertDeepEqual({a: 1, b: [1, 2, {c: 3}]}, {b: [1, 2, {c: 3}], a: 1});
});
test('assertDeepEqual detects differences', () => {
    assertThrows(() => assertDeepEqual({a: 1}, {a: 2}));
    assertThrows(() => assertDeepEqual([1, 2], [1, 2, 3]));
    assertThrows(() => assertDeepEqual([], {}));
});
test('assertEqual and assertTrue', () => {
    assertEqual(1, 1);
    assertThrows(() => assertEqual(1, 2));
    assertTrue(true);
    assertThrows(() => assertTrue(0));
});
test('assertRejects checks the pattern', async () => {
    await assertRejects(Promise.reject(new Error('boom')), /boom/);
    await assertRejects(assertRejects(Promise.reject(new Error('boom')), /other/));
    await assertRejects(assertRejects(Promise.resolve()));
});
test('async tests can wait for a GLib timeout', async () => {
    const value = await new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
            resolve(42);
            return GLib.SOURCE_REMOVE;
        });
    });
    assertEqual(value, 42);
});

await run();
