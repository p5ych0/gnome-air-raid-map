// SPDX-License-Identifier: MIT
import Cairo from 'cairo';
import {test, run, assertTrue} from '../lib/assert.js';
import {Canvas2D} from '../../core/canvas.js';
import {marker} from '../../core/symbols.js';
import {pixelAt, pixelReader, assertColorNear} from '../lib/pixels.js';

function setup(w = 40, h = 40) {
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, w, h);
    const cr = new Cairo.Context(surface);
    const ctx = new Canvas2D(cr);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);
    return {surface, cr, ctx};
}

for (const type of ['uav', 'fpv', 'recon', 'missile', 'ballistic', 'kab', 'mig31k', 'unknown', 'future-type']) {
    test(`draws ${type}`, () => {
        const {surface, cr, ctx} = setup();
        marker(ctx, {type, advisory: false, heading: null, count: 0}, 20, 20, 16);
        assertColorNear(pixelAt(surface, 20, 20), '#ffffff');
        cr.$dispose();
    });
}

test('advisory markers are blue', () => {
    const {surface, cr, ctx} = setup();
    marker(ctx, {type: 'uav', advisory: true, heading: null, count: 0}, 20, 20, 16);
    assertColorNear(pixelAt(surface, 20, 20), '#9ad6f7');
    cr.$dispose();
});

test('group count is drawn below the icon', () => {
    const {surface, cr, ctx} = setup();
    marker(ctx, {type: 'uav', advisory: false, heading: null, count: 3}, 20, 20, 16);
    const read = pixelReader(surface);
    let found = false;
    for (let y = 30; y <= 38 && !found; ++y)
        for (let x = 0; x < 40 && !found; ++x)
            if (read(x, y)[0] > 200) found = true;
    assertTrue(found, 'no count glyph pixels');
    cr.$dispose();
});

// Draws a 16 px group of 12 on an 80 x 60 surface; returns a pixel reader.
function group(x, y, bounds) {
    const {surface, cr, ctx} = setup(80, 60);
    marker(ctx, {type: 'uav', advisory: false, heading: null, count: 12}, x, y, 16, bounds);
    const read = pixelReader(surface);
    cr.$dispose();
    return read;
}
const inkIn = (read, x0, y0, x1, y1) => {
    let n = 0;
    for (let y = y0; y < y1; ++y)
        for (let x = x0; x < x1; ++x)
            if (read(x, y)[0] > 0) ++n;
    return n;
};
const sameRows = (a, b, y0, y1) => {
    for (let y = y0; y < y1; ++y)
        for (let x = 0; x < 80; ++x)
            if (a(x, y).some((v, i) => v !== b(x, y)[i])) return false;
    return true;
};

// The icon spans rows 12-27; the label below it starts at row 30.
for (const [side, x, bounds, outside] of [
    ['left', 32, {left: 30, top: 0, right: 80, bottom: 60}, [0, 29, 30, 60]],
    ['right', 48, {left: 0, top: 0, right: 50, bottom: 60}, [50, 29, 80, 60]],
]) {
    test(`group count stays inside the ${side} bound and the icon does not move`, () => {
        const read = group(x, 20, bounds);
        assertTrue(inkIn(read, 0, 29, 80, 60) > 0, 'no count glyph pixels');
        assertTrue(inkIn(read, ...outside) === 0, `count ink outside the ${side} bound`);
        assertColorNear(read(x, 20), '#ffffff');
        assertTrue(sameRows(read, group(x, 20, null), 0, 29), 'the icon moved');
    });
}

test('group count goes above the icon at the bottom bound', () => {
    // The icon spans rows 22-37; the label would start at row 40.
    const read = group(40, 30, {left: 0, top: 0, right: 80, bottom: 40});
    assertTrue(inkIn(read, 0, 40, 80, 60) === 0, 'count ink below the bottom bound');
    assertTrue(inkIn(read, 0, 0, 80, 21) > 0, 'no count above the icon');
    assertColorNear(read(40, 30), '#ffffff');
    assertTrue(sameRows(read, group(40, 30, null), 21, 40), 'the icon moved');
});

await run();
