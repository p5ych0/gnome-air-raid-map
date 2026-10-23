// SPDX-License-Identifier: MIT
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {test, run, assertDeepEqual} from '../lib/assert.js';
import {parseCurrentState} from '../../updater/display.js';

const fixtureFile = Gio.File.new_for_uri(import.meta.url).get_parent()
    .resolve_relative_path('fixtures/displayconfig-two-monitors.txt');
const [, bytes] = fixtureFile.load_contents(null);
const fixtureText = new TextDecoder().decode(bytes).trim();
const FIRST = '(0, 0, 1.0, uint32 0, true,';

function parse(text) {
    return parseCurrentState(GLib.Variant.parse(
        new GLib.VariantType('(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})'), text, null, null));
}

test('parses the captured two-monitor state', () => {
    assertDeepEqual(parse(fixtureText), {mode: 'logical', monitors: [
        {x: 0, y: 0, width: 1920, height: 1080, scale: 1, primary: true},
        {x: 1920, y: 0, width: 1080, height: 1920, scale: 1, primary: false}]});
});

test('rotation swaps width and height', () => {
    const state = parse(fixtureText.replace(FIRST, '(0, 0, 1.0, uint32 1, true,'));
    assertDeepEqual(state.monitors[0], {x: 0, y: 0, width: 1080, height: 1920, scale: 1, primary: true});
});

test('logical size divides by scale', () => {
    const state = parse(fixtureText.replace(FIRST, '(0, 0, 2.0, uint32 0, true,'));
    assertDeepEqual(state.monitors[0], {x: 0, y: 0, width: 960, height: 540, scale: 2, primary: true});
});

test('physical layout mode keeps physical sizes', () => {
    const state = parse(fixtureText.replace(FIRST, '(0, 0, 2.0, uint32 0, true,')
        .replace("'layout-mode': <uint32 1>", "'layout-mode': <uint32 2>"));
    assertDeepEqual(state.mode, 'physical');
    assertDeepEqual(state.monitors[0], {x: 0, y: 0, width: 1920, height: 1080, scale: 2, primary: true});
});

await run();
