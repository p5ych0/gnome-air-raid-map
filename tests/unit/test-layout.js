// SPDX-License-Identifier: MIT
import {test, run, assertEqual, assertDeepEqual, assertTrue, assertThrows} from '../lib/assert.js';
import {pictureLayout, parseDisplayOverride, PIXEL_CAP} from '../../core/layout.js';

function L(...rows) {
    return {mode: 'logical', monitors: rows.map(([x, y, width, height, scale], i) =>
        ({x, y, width, height, scale, primary: i === 0}))};
}

test('pixel cap value', () => assertEqual(PIXEL_CAP, 16600000));
test('single 1080p', () => assertDeepEqual(pictureLayout(L([0,0,1920,1080,1])),
  {width:1920, height:1080, monitors:[{x:0,y:0,width:1920,height:1080,scale:1}]}));
test('4K at 200 %', () => assertDeepEqual(pictureLayout(L([0,0,1920,1080,2])),
  {width:3840, height:2160, monitors:[{x:0,y:0,width:3840,height:2160,scale:2}]}));
test('landscape plus portrait', () => assertDeepEqual(pictureLayout(L([0,0,1920,1080,1],[1920,0,1080,1920,1])),
  {width:3000, height:1920, monitors:[{x:0,y:0,width:1920,height:1080,scale:1},{x:1920,y:0,width:1080,height:1920,scale:1}]}));
test('mixed scale uses the highest scale', () => assertDeepEqual(pictureLayout(L([0,0,1920,1080,1],[1920,0,1920,1080,2])),
  {width:7680, height:2160, monitors:[{x:0,y:0,width:3840,height:2160,scale:2},{x:3840,y:0,width:3840,height:2160,scale:2}]}));
test('fractional scale tiles exactly', () => {
  const l = pictureLayout(L([0,0,2048,1152,1.25],[2048,0,2048,1152,1.25]));
  assertDeepEqual([l.width, l.height], [5120, 1440]);
  assertEqual(l.monitors[0].x + l.monitors[0].width, l.monitors[1].x);
});
test('cap keeps the aspect ratio', () => {
  const l = pictureLayout(L([0,0,3840,2160,1],[3840,0,3840,2160,1],[7680,0,3840,2160,1]));
  assertTrue(l.width * l.height <= 16600000);
  assertTrue(Math.abs(l.width / l.height - 11520 / 2160) < 0.002);
  assertEqual(l.monitors[2].x + l.monitors[2].width, l.width);
});
// Each edge is rounded after the cap factor, and the rounding can add pixels (#3).
test('two 5K monitors fit in the cap after the rounding', () => {
  const l = pictureLayout(L([0,0,5120,2880,1],[5120,0,5120,2880,1]));
  assertTrue(l.width * l.height <= PIXEL_CAP, `${l.width} x ${l.height} = ${l.width * l.height}`);
  assertEqual(l.monitors[0].width + l.monitors[1].width, l.width);
});
test('every capped size fits in the cap', () => {
  const over = [];
  for (let w = 3000; w <= 9000; w += 37)
    for (let h = 1500; h <= 5000; h += 41) {
      const l = pictureLayout(L([0,0,w,h,1]));
      if (l.width * l.height > PIXEL_CAP) over.push(`${w}x${h}`);
    }
  assertEqual(over.length, 0, `over the cap: ${over.slice(0, 5).join(' ')}`);
});
test('physical mode scales text, not the picture', () => assertDeepEqual(
  pictureLayout({mode:'physical', monitors:[{x:0,y:0,width:3840,height:2160,scale:2,primary:true}]}),
  {width:3840, height:2160, monitors:[{x:0,y:0,width:3840,height:2160,scale:2}]}));
test('layout is translated to the origin', () => assertDeepEqual(
  pictureLayout(L([-1920,100,1920,1080,1])),
  {width:1920, height:1080, monitors:[{x:0,y:0,width:1920,height:1080,scale:1}]}));
test('override string', () => assertDeepEqual(parseDisplayOverride('3840x2160@2,1080x1920@1'),
  {mode:'logical', monitors:[{x:0,y:0,width:1920,height:1080,scale:2,primary:true},{x:1920,y:0,width:1080,height:1920,scale:1,primary:false}]}));
test('bad override string', () => assertThrows(() => parseDisplayOverride('nonsense')));

function errorOf(fn) {
  try {
    fn();
  } catch (e) {
    return e.message;
  }
  return 'no error';
}
test('no monitors is an error', () =>
  assertEqual(errorOf(() => pictureLayout({mode:'logical', monitors:[]})), 'No monitors'));
test('empty monitor layout is an error', () => {
  assertEqual(errorOf(() => pictureLayout(L([0,0,0,1080,1]))), 'Empty monitor layout');
  assertEqual(errorOf(() => pictureLayout(L([0,0,1920,0,1]))), 'Empty monitor layout');
});

await run();
