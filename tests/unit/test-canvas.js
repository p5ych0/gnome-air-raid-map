// SPDX-License-Identifier: MIT
import Cairo from 'cairo';
import {test, run, assertDeepEqual, assertTrue} from '../lib/assert.js';
import {parseColor, Canvas2D} from '../../core/canvas.js';
import {pixelAt, assertColorNear} from '../lib/pixels.js';

function setup(w, h, background = '#000000') {
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, w, h);
    const cr = new Cairo.Context(surface);
    const ctx = new Canvas2D(cr);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
    return {surface, cr, ctx};
}

test('parses rgb and qml argb colors', () => {
    assertDeepEqual(parseColor('#cf4655').map(v => Math.round(v * 255)), [207, 70, 85, 255]);
    assertDeepEqual(parseColor('#de152331').map(v => Math.round(v * 255)), [21, 35, 49, 222]);
});

test('fill keeps the path for a following stroke', () => {
    const {surface, cr, ctx} = setup(20, 20);
    ctx.beginPath();
    ctx.moveTo(5, 5); ctx.lineTo(15, 5); ctx.lineTo(15, 15); ctx.lineTo(5, 15); ctx.closePath();
    ctx.fillStyle = '#ff0000';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#0000ff';
    ctx.stroke();
    assertColorNear(pixelAt(surface, 10, 10), '#ff0000');
    assertColorNear(pixelAt(surface, 5, 10), '#0000ff');
    cr.$dispose();
});

test('global alpha blends', () => {
    const {surface, cr, ctx} = setup(10, 10);
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 10, 10);
    assertColorNear(pixelAt(surface, 5, 5), '#808080', 2);
    cr.$dispose();
});

test('center aligned text is centered', () => {
    const {surface, cr, ctx} = setup(200, 40);
    ctx.font = '20px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.fillText('Ж', 100, 20);
    const bright = [];
    for (let x = 0; x < 200; ++x)
        if (pixelAt(surface, x, 20)[0] > 200) bright.push(x);
    assertTrue(bright.some(x => x >= 92 && x <= 108), 'no white pixel near the center');
    assertTrue(bright.every(x => x >= 80 && x <= 120), 'text is not centered');
    cr.$dispose();
});

test('stroke text draws an outline', () => {
    const {surface, cr, ctx} = setup(60, 30);
    ctx.font = '600 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.strokeText('Ж', 30, 15);
    let found = false;
    for (let x = 15; x < 45 && !found; ++x)
        for (let y = 5; y < 25 && !found; ++y)
            if (pixelAt(surface, x, y)[0] > 200) found = true;
    assertTrue(found, 'no stroked pixels');
    cr.$dispose();
});

test('clearRect makes pixels transparent and reset restores state', () => {
    const {surface, cr, ctx} = setup(10, 10, '#ff0000');
    ctx.translate(100, 100);
    ctx.reset();
    ctx.clearRect(0, 0, 5, 10);
    ctx.fillStyle = '#00ff00';
    ctx.fillRect(0, 0, 2, 10);
    assertColorNear(pixelAt(surface, 1, 5), '#00ff00');
    const cleared = pixelAt(surface, 3, 5);
    assertTrue(cleared[0] < 50, `cleared pixel is still red: ${cleared}`);
    assertColorNear(pixelAt(surface, 8, 5), '#ff0000');
    cr.$dispose();
});
await run();
