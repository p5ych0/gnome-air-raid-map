// SPDX-License-Identifier: MIT
import GLib from 'gi://GLib';
import System from 'system';

const tests = [];

export function test(name, fn) {
    tests.push({name, fn});
}

function describe(value) {
    try {
        const text = JSON.stringify(value);
        return text === undefined ? String(value) : text;
    } catch (e) {
        return String(value);
    }
}

function deepEqual(a, b) {
    if (Object.is(a, b)) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const keysA = Object.keys(a), keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(key => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
}

export function assertEqual(actual, expected, msg) {
    if (!Object.is(actual, expected))
        throw new Error(`${msg ? `${msg}: ` : ''}expected ${describe(expected)}, got ${describe(actual)}`);
}

export function assertDeepEqual(actual, expected, msg) {
    if (!deepEqual(actual, expected))
        throw new Error(`${msg ? `${msg}: ` : ''}expected ${describe(expected)}, got ${describe(actual)}`);
}

export function assertTrue(value, msg) {
    if (!value) throw new Error(msg || `expected a truthy value, got ${describe(value)}`);
}

export function assertThrows(fn, msg) {
    try {
        fn();
    } catch (e) {
        return;
    }
    throw new Error(msg || 'expected the function to throw');
}

export async function assertRejects(promise, pattern) {
    try {
        await promise;
    } catch (e) {
        if (pattern && !pattern.test(String(e && e.message !== undefined ? e.message : e)))
            throw new Error(`rejection ${describe(String(e))} does not match ${pattern}`);
        return;
    }
    throw new Error('expected the promise to reject');
}

// Runs the registered tests in order inside a GLib main loop, so promises that
// wait on GLib callbacks can complete. Exits with status 1 if any test fails.
export function run() {
    const loop = GLib.MainLoop.new(null, false);
    let failed = 0;
    (async () => {
        for (const {name, fn} of tests) {
            try {
                await fn();
                print(`ok - ${name}`);
            } catch (e) {
                ++failed;
                print(`not ok - ${name}: ${e && e.message !== undefined ? e.message : e}`);
            }
        }
    })().catch(e => {
        ++failed;
        print(`not ok - runner: ${e}`);
    }).finally(() => loop.quit());
    loop.run();
    if (failed) System.exit(1);
    return Promise.resolve();
}
