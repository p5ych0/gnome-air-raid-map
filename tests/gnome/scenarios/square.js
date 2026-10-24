// SPDX-License-Identifier: MIT
// Helper of scenarios/install.sh: checks the color that a GNOME screenshot shows
// inside the synthetic square of fixture.js on each monitor. The point is lon 24,
// lat 45: inside the square and away from the threat symbols and the text (INSIDE
// in tests/unit/test-run.js).
// Usage: gjs -m square.js <screen.png> <layout.json> <#rrggbb>
// layout.json: the result of pictureLayout (core/layout.js), as for compare.js.
// It prints "monitor-<n> (<x>, <y>) [<r>,<g>,<b>]" with the screenshot pixel.
// Exit 1 if a channel of a pixel differs from the color by more than 12.
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import System from 'system';
import {parseColor} from '../../../core/canvas.js';
import {project} from '../../../core/mapdata.js';
import {mapTransform, toScreen} from '../../../core/render.js';
import {syntheticGeometry} from '../../lib/fixtures.js';
import {pixelReaderFromPath} from '../../lib/pixels.js';

const TOLERANCE = 12, POINT = [24, 45];

if (ARGV.length !== 3) {
    printerr('usage: square.js <screen.png> <layout.json> <#rrggbb>');
    System.exit(2);
}
const [screenPath, layoutPath, hex] = ARGV;
const [format, screenWidth, screenHeight] = GdkPixbuf.Pixbuf.get_file_info(screenPath);
if (!format) throw new Error(`not a picture: ${screenPath}`);
const at = pixelReaderFromPath(screenPath);
const layout = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(layoutPath)[1]));
const bounds = syntheticGeometry().oblasts.bounds;
const color = parseColor(hex).slice(0, 3).map(v => Math.round(v * 255));

let status = 0;
layout.monitors.forEach((m, index) => {
    // drawMonitor (core/render.js) draws the map in logical pixels of the monitor.
    const t = mapTransform(bounds, m.width / m.scale, m.height / m.scale);
    const [lx, ly] = toScreen(t, project(POINT));
    // Picture pixels, then screenshot pixels (GNOME maps the layout over the screen).
    const x = Math.floor((m.x + lx * m.scale) * screenWidth / layout.width);
    const y = Math.floor((m.y + ly * m.scale) * screenHeight / layout.height);
    const shown = at(x, y);
    print(`monitor-${index + 1} (${x}, ${y}) [${shown}]`);
    if (!shown.every((v, k) => Math.abs(v - color[k]) <= TOLERANCE)) {
        print(`# monitor-${index + 1}: [${shown}] is not ${hex}`);
        status = 1;
    }
});
System.exit(status);
