// SPDX-License-Identifier: MIT
// Checks that a GNOME screenshot shows the wallpaper picture in the right place on
// each monitor (spec 5.6, plan Task 9).
// Usage: gjs -m tests/gnome/compare.js [--zoom] <picture.png> <screen.png> <layout.json>
// layout.json: {width, height, monitors: [{x, y, width, height, scale}]}, the result
// of pictureLayout (core/layout.js): picture pixels, and scale is picture pixels
// per logical pixel.
//
// For each monitor it samples a 5 x 5 grid inside the monitor rectangle. The grid
// skips the top 48 and the left 80 logical pixels: the top bar and the Ubuntu dock
// cover them. Each sample maps from layout pixels to screenshot pixels by the ratio
// of the two sizes. It prints "monitor-<n> <matches>/25", and a "#" line for each
// sample that does not match. Exit 1 if a sample does not match, or if the
// screenshot has another aspect ratio than the layout (a stretched picture).
//
// Picture options (picture-options):
// - spanned (default): the picture is the layout; it covers all monitors.
// - --zoom: each monitor shows the whole picture, scaled to cover the monitor and
//   centered (Mutter G_DESKTOP_BACKGROUND_STYLE_ZOOM). The picture can have any size.
//
// A sample matches if each channel of the screenshot pixel is at most 12 outside
// the range of the picture pixels that GNOME can mix into that screen pixel (the
// footprint of the screen pixel, plus one pixel on each side). In a flat area this
// is the plain rule "differs by 12 or less". Near an edge it accepts the filtering
// of a scaled picture, but not a shift of more than one pixel.
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import System from 'system';
import {pixelReaderFromPath} from '../lib/pixels.js';

const TOLERANCE = 12, GRID = 5, SKIP_TOP = 48, SKIP_LEFT = 80;

const args = [...ARGV];
const zoom = args[0] === '--zoom';
if (zoom) args.shift();
if (args.length !== 3) {
    printerr('usage: compare.js [--zoom] <picture.png> <screen.png> <layout.json>');
    System.exit(2);
}
const [picturePath, screenPath, layoutPath] = args;

function image(path) {
    const [format, width, height] = GdkPixbuf.Pixbuf.get_file_info(path);
    if (!format) throw new Error(`not a picture: ${path}`);
    return {width, height, at: pixelReaderFromPath(path)};
}

const picture = image(picturePath), screen = image(screenPath);
const layout = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(layoutPath)[1]));

// Screenshot pixels per layout pixel. GNOME maps the layout over the whole screen.
const sx = screen.width / layout.width, sy = screen.height / layout.height;
let status = 0;
if (Math.abs(sx / sy - 1) > 0.005) {
    print(`# screen ${screen.width}x${screen.height} and layout ${layout.width}x${layout.height} ` +
        'have different aspect ratios');
    status = 1;
}
if (!zoom && (picture.width !== layout.width || picture.height !== layout.height)) {
    print(`# picture ${picture.width}x${picture.height} is not the layout size ${layout.width}x${layout.height}`);
    status = 1;
}

// Layout point -> picture point, and picture pixels per layout pixel, for monitor m.
function toPicture(m) {
    if (!zoom) return {map: (x, y) => [x, y], ratio: 1};
    const cover = Math.max(m.width / picture.width, m.height / picture.height);
    const cx = m.x + m.width / 2, cy = m.y + m.height / 2;
    return {
        map: (x, y) => [picture.width / 2 + (x - cx) / cover, picture.height / 2 + (y - cy) / cover],
        ratio: 1 / cover,
    };
}

const clamp = (v, max) => Math.min(Math.max(v, 0), max - 1);

// The range of each channel in the picture over a box of half-size r around (x, y).
function pictureRange(x, y, r) {
    const lo = [255, 255, 255], hi = [0, 0, 0];
    const x0 = clamp(Math.floor(x - r), picture.width), x1 = clamp(Math.floor(x + r), picture.width);
    const y0 = clamp(Math.floor(y - r), picture.height), y1 = clamp(Math.floor(y + r), picture.height);
    for (let py = y0; py <= y1; py++) {
        for (let px = x0; px <= x1; px++) {
            const rgb = picture.at(px, py);
            for (let k = 0; k < 3; k++) {
                lo[k] = Math.min(lo[k], rgb[k]);
                hi[k] = Math.max(hi[k], rgb[k]);
            }
        }
    }
    return {lo, hi};
}

layout.monitors.forEach((m, index) => {
    const name = `monitor-${index + 1}`;
    const {map, ratio} = toPicture(m);
    // Picture pixels in one screen pixel, plus one pixel on each side.
    const reach = Math.max(1, ratio / sx) / 2 + 1;
    const left = SKIP_LEFT * m.scale, top = SKIP_TOP * m.scale;
    let matches = 0;
    for (let j = 0; j < GRID; j++) {
        for (let i = 0; i < GRID; i++) {
            const lx = m.x + left + (i + 0.5) * (m.width - left) / GRID;
            const ly = m.y + top + (j + 0.5) * (m.height - top) / GRID;
            const sxPixel = Math.floor(lx * sx), syPixel = Math.floor(ly * sy);
            const [px, py] = map(lx, ly);
            const shown = screen.at(clamp(sxPixel, screen.width), clamp(syPixel, screen.height));
            const {lo, hi} = pictureRange(px, py, reach);
            if (shown.every((v, k) => v >= lo[k] - TOLERANCE && v <= hi[k] + TOLERANCE)) {
                matches++;
            } else {
                print(`# ${name}: screen (${sxPixel}, ${syPixel}) is [${shown}], ` +
                    `picture (${Math.round(px)}, ${Math.round(py)}) is [${lo}]..[${hi}]`);
            }
        }
    }
    print(`${name} ${matches}/${GRID * GRID}`);
    if (matches !== GRID * GRID) status = 1;
});
System.exit(status);
