// SPDX-License-Identifier: MIT
import Cairo from 'cairo';
import {test, run, assertTrue} from '../lib/assert.js';
import {Canvas2D} from '../../core/canvas.js';
import {marker} from '../../core/symbols.js';
import {pixelAt, assertColorNear} from '../lib/pixels.js';

function setup() {
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, 40, 40);
    const cr = new Cairo.Context(surface);
    const ctx = new Canvas2D(cr);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, 40, 40);
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
    let found = false;
    for (let y = 30; y <= 38 && !found; ++y)
        for (let x = 0; x < 40 && !found; ++x)
            if (pixelAt(surface, x, y)[0] > 200) found = true;
    assertTrue(found, 'no count glyph pixels');
    cr.$dispose();
});

await run();
