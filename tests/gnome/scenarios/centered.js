// SPDX-License-Identifier: MIT
// Helper of scenarios/install.sh: checks that a GNOME screenshot shows a picture with
// picture-options 'centered' on each monitor: the picture at its own size in the
// center of the monitor, and the primary color around it (spec 5.7). Without a
// picture, it checks that each monitor shows only the color.
// Usage: gjs -m centered.js <screen.png> <monitors.json> <#rrggbb> [<picture.png>]
// monitors.json: [[x, y, width, height, scale], ...], from Main.layoutManager.monitors.
// Each monitor must have scale 1: a screenshot pixel is then a logical pixel.
//
// For each monitor it compares every picture pixel that is on the monitor with the
// screen pixel, and a 9 x 9 grid of samples outside the picture with the color. As
// compare.js does, it skips the top 48 and the left 80 pixels of each monitor: the
// top bar and the Ubuntu dock cover them. A pixel matches if each channel differs
// by 12 or less. It prints "monitor-<n> picture <matches>/<pixels>, color
// <matches>/<samples>", and a "#" line for the first pixels that do not match.
// Exit 1 if a pixel does not match.
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import System from 'system';
import {parseColor} from '../../../core/canvas.js';
import {pixelReaderFromPath} from '../../lib/pixels.js';

const TOLERANCE = 12, GRID = 9, SKIP_TOP = 48, SKIP_LEFT = 80, MAX_REPORTS = 5;

if (ARGV.length !== 3 && ARGV.length !== 4) {
    printerr('usage: centered.js <screen.png> <monitors.json> <#rrggbb> [<picture.png>]');
    System.exit(2);
}
const [screenPath, monitorsPath, hex, picturePath] = ARGV;

function image(path) {
    const [format, width, height] = GdkPixbuf.Pixbuf.get_file_info(path);
    if (!format) throw new Error(`not a picture: ${path}`);
    return {width, height, at: pixelReaderFromPath(path)};
}

const screen = image(screenPath);
const picture = picturePath ? image(picturePath) : {width: 0, height: 0, at: null};
const monitors = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(monitorsPath)[1]));
const color = parseColor(hex).slice(0, 3).map(v => Math.round(v * 255));
const matches = (a, b) => a.every((v, k) => Math.abs(v - b[k]) <= TOLERANCE);

let status = 0;
monitors.forEach(([mx, my, width, height, scale], index) => {
    const name = `monitor-${index + 1}`;
    if (scale !== 1) {
        print(`# ${name}: scale ${scale}; this check needs scale 1`);
        status = 1;
        return;
    }
    // The visible part of the monitor, and the picture rectangle on the screen.
    const left = mx + SKIP_LEFT, top = my + SKIP_TOP, right = mx + width, bottom = my + height;
    const px = mx + Math.floor((width - picture.width) / 2);
    const py = my + Math.floor((height - picture.height) / 2);
    const inPicture = (x, y) => x >= px && x < px + picture.width && y >= py && y < py + picture.height;
    let reports = 0;
    const report = text => {
        if (reports++ < MAX_REPORTS) print(`# ${name}: ${text}`);
    };

    let pictureMatches = 0, pixels = 0;
    for (let y = Math.max(py, top); y < Math.min(py + picture.height, bottom); y++) {
        for (let x = Math.max(px, left); x < Math.min(px + picture.width, right); x++) {
            pixels++;
            const shown = screen.at(x, y), want = picture.at(x - px, y - py);
            if (matches(shown, want)) pictureMatches++;
            else report(`screen (${x}, ${y}) is [${shown}], picture (${x - px}, ${y - py}) is [${want}]`);
        }
    }

    let colorMatches = 0, samples = 0;
    for (let j = 0; j < GRID; j++) {
        for (let i = 0; i < GRID; i++) {
            const x = Math.floor(left + (i + 0.5) * (right - left) / GRID);
            const y = Math.floor(top + (j + 0.5) * (bottom - top) / GRID);
            if (inPicture(x, y)) continue;
            samples++;
            const shown = screen.at(x, y);
            if (matches(shown, color)) colorMatches++;
            else report(`screen (${x}, ${y}) is [${shown}], not ${hex}`);
        }
    }
    print(`${name} picture ${pictureMatches}/${pixels}, color ${colorMatches}/${samples}`);
    if (pictureMatches !== pixels || colorMatches !== samples || samples === 0 || (picturePath && pixels === 0))
        status = 1;
});
System.exit(status);
