// SPDX-License-Identifier: MIT
import {test, run, assertEqual, assertDeepEqual, assertTrue} from '../lib/assert.js';
import {pixelAt, pixelReader, assertColorNear} from '../lib/pixels.js';
import {syntheticGeometry, syntheticThreats, syntheticView} from '../lib/fixtures.js';
import {project, prepareGeometry, parseSnapshot, parseThreats} from '../../core/mapdata.js';
import {pictureLayout, parseDisplayOverride} from '../../core/layout.js';
import Cairo from 'cairo';
import {mapTransform, toScreen, visibleThreats, areaListLimit, areaListPlan, areaItemText, renderPicture,
    drawMonitor, monitorPlan} from '../../core/render.js';

const L1080 = pictureLayout(parseDisplayOverride('1920x1080@1'));
const bounds = syntheticGeometry().oblasts.bounds;
const t = mapTransform(bounds, 1920, 1080);
const INSIDE = project([24, 45]);

function redAlert() {
    const g = syntheticGeometry();
    return parseSnapshot({oblasts: [{key: 'test'}], raions: []}, g.oblasts, g.raions);
}

// Draws with the default synthetic data; returns a pixel reader and frees the surface.
function draw(overrides = {}, layout = L1080, geometry = syntheticGeometry()) {
    const surface = renderPicture(layout, geometry, syntheticView(overrides));
    const read = pixelReader(surface);
    surface.finish();
    return read;
}

function screen(transform, point, rect = {x: 0, y: 0, scale: 1}) {
    const [x, y] = toScreen(transform, point);
    return [Math.round(rect.x + x * rect.scale), Math.round(rect.y + y * rect.scale)];
}

const bright = ([r, g, b]) => r + g + b > 450;
const near = (pixel, hex, tolerance) => {
    try { assertColorNear(pixel, hex, tolerance); return true; } catch (e) { return false; }
};

function countIn(read, x0, y0, x1, y1, predicate) {
    let n = 0;
    for (let y = y0; y < y1; ++y)
        for (let x = x0; x < x1; ++x)
            if (predicate(read(x, y))) ++n;
    return n;
}

test('background outside the map', () => {
    const surface = renderPicture(L1080, syntheticGeometry(), syntheticView());
    assertColorNear(pixelAt(surface, 5, 5), '#0e1722');
    surface.finish();
});

test('red alert fills the oblast', () => {
    const [x, y] = screen(t, INSIDE);
    assertColorNear(draw({alerts: redAlert()})(x, y), '#cf4655');
});

test('a hole with the exterior winding is not filled by an alert', () => {
    const ring = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
    const oblasts = prepareGeometry({type: 'FeatureCollection', features: [{
        properties: {key: 'test', region: 'HOLE'},
        geometry: {type: 'Polygon', coordinates: [ring(22, 44, 40, 52), ring(28, 47, 34, 49)]},
    }]});
    const geometry = {oblasts, raions: oblasts};
    const alerts = parseSnapshot({oblasts: [{key: 'test'}], raions: []}, oblasts, oblasts);
    const read = draw({alerts, threats: {points: [], count: 0, areas: []}}, L1080, geometry);
    const tr = mapTransform(oblasts.bounds, 1920, 1080);
    assertColorNear(read(...screen(tr, project([31, 48]))), '#0e1722');
    assertColorNear(read(...screen(tr, project([25, 48]))), '#cf4655');
});

test('stale alerts are dimmed', () => {
    const [x, y] = screen(t, INSIDE);
    // 0.4 * #cf4655 over #223448 = (103, 59, 77).
    assertColorNear(draw({alerts: redAlert(), alertsStale: true})(x, y), '#673b4d');
});

test('fresh threats are drawn', () => {
    const read = draw();
    for (const threat of parseThreats({threats: syntheticThreats()}).points) {
        const [x, y] = screen(t, threat.point);
        assertTrue(countIn(read, x - 10, y - 10, x + 10, y + 10, bright) > 0, `no marker for ${threat.id}`);
    }
});

test('stale threats are hidden', () => {
    const read = draw({threatsStale: true});
    for (const threat of parseThreats({threats: syntheticThreats()}).points) {
        const [x, y] = screen(t, threat.point);
        assertEqual(countIn(read, x - 10, y - 10, x + 10, y + 10, bright), 0, `marker for ${threat.id}`);
    }
});

test('off-map threats are dropped', () => {
    assertEqual(visibleThreats([{point: project([60, 50])}], t, 1920, 1080).length, 0);
    assertEqual(visibleThreats([{point: project([31, 48])}], t, 1920, 1080).length, 1);
});

test('portrait keeps the whole map inside the monitor', () => {
    const p = mapTransform(bounds, 1080, 1920);
    for (const [x, y] of [toScreen(p, [bounds[0], bounds[1]]), toScreen(p, [bounds[2], bounds[3]])]) {
        assertTrue(x >= 0 && x <= 1080, `x ${x} is outside the monitor`);
        assertTrue(y >= 0 && y <= 1920, `y ${y} is outside the monitor`);
    }
});

test('each monitor gets its own map', () => {
    const layout = pictureLayout(parseDisplayOverride('1920x1080@1,1080x1920@1'));
    const read = draw({alerts: redAlert()}, layout);
    for (const rect of layout.monitors) {
        const own = mapTransform(bounds, rect.width / rect.scale, rect.height / rect.scale);
        const [x, y] = screen(own, INSIDE, rect);
        assertColorNear(read(x, y), '#cf4655');
    }
});

// A monitor with the size and scale of an earlier monitor gets a copy of its pixels (Task 11b).
const copies = display => monitorPlan(pictureLayout(parseDisplayOverride(display)).monitors)
    .map(({copyOf}, i, plan) => (copyOf ? plan.findIndex(entry => entry.rect === copyOf) : -1));

test('a monitor with the size and scale of an earlier monitor copies it', () => {
    assertDeepEqual(copies('3840x2160@1,3840x2160@1'), [-1, 0]);
    assertDeepEqual(copies('1920x1080@1,1920x1080@1,1920x1080@1'), [-1, 0, 0]);
    // At the size cap the widths are 3136, 3137 and 3136 pixels.
    assertDeepEqual(copies('3840x2160@1,3840x2160@1,3840x2160@1'), [-1, -1, 0]);
    assertDeepEqual(copies('1920x1080@1,2560x1440@1'), [-1, -1]);
    assertDeepEqual(copies('1920x1080@1,1080x1920@1'), [-1, -1]);
});

test('overlapping monitors are all drawn', () => {
    const monitors = [0, 50, 200].map(x => ({x, y: 0, width: 100, height: 100, scale: 1}));
    assertDeepEqual(monitorPlan(monitors).map(entry => entry.copyOf), [null, null, null]);
});

// The pixels of monitor index in the picture that differ from the same monitor drawn on its own.
function differFromAlone(layout, index) {
    const view = syntheticView({alerts: redAlert()});
    const drawn = renderPicture(layout, syntheticGeometry(), view);
    const picture = pixelReader(drawn);
    drawn.finish();
    const rect = layout.monitors[index];
    const surface = new Cairo.ImageSurface(Cairo.Format.RGB24, layout.width, layout.height);
    const cr = new Cairo.Context(surface);
    drawMonitor(cr, rect, syntheticGeometry(), view);
    cr.$dispose();
    const alone = pixelReader(surface);
    surface.finish();
    let differ = 0;
    for (let y = rect.y; y < rect.y + rect.height; ++y)
        for (let x = rect.x; x < rect.x + rect.width; ++x)
            if (picture(x, y).some((v, i) => v !== alone(x, y)[i])) ++differ;
    return differ;
}

test('a copied monitor has the pixels of a drawn monitor', () => {
    const layout = pictureLayout(parseDisplayOverride('640x360@1,800x450@1,640x360@1'));
    assertEqual(differFromAlone(layout, 2), 0, 'pixels that differ');
});

test('a copied monitor at a scale that is not a whole number has the pixels of a drawn monitor', () => {
    // A cap of 1290240 pixels scales the picture by 0.8367, as the size cap does for large
    // layouts. Each monitor then has 1071x602 pixels.
    const layout = pictureLayout(parseDisplayOverride('1280x720@1,1280x720@1'), 1290240);
    assertDeepEqual(layout.monitors.map(({x, width, height}) => [x, width, height]), [[0, 1071, 602], [1071, 1071, 602]]);
    assertTrue(!Number.isInteger(layout.monitors[1].scale), `scale ${layout.monitors[1].scale}`);
    assertDeepEqual(monitorPlan(layout.monitors).map(entry => entry.copyOf), [null, layout.monitors[0]]);
    assertEqual(differFromAlone(layout, 1), 0, 'pixels that differ');
});

test('scale 2 draws the logical layout at twice the size', () => {
    const layout = pictureLayout(parseDisplayOverride('3840x2160@2'));
    const read = draw({alerts: redAlert()}, layout);
    assertColorNear(read(...screen(t, INSIDE, layout.monitors[0])), '#cf4655');
    assertColorNear(read(...screen(t, project([20, 45]), layout.monitors[0])), '#0e1722');
});

test('area item text', () => {
    assertEqual(areaItemText({region: 'Тестова область', label: 'Ракета', count: 0, advisory: false}),
        'Тестова область · Ракета');
    assertEqual(areaItemText({region: 'Інша область', label: 'МіГ-31К', count: 2, advisory: true}),
        'Інша область · МіГ-31К ×2\nСпостереження');
});

test('markup characters render literally', () => { // Review Focus 4
    assertEqual(areaItemText({region: 'A & <b>B', label: 'Ракета', count: 0, advisory: false}), 'A & <b>B · Ракета');
    const area = region => ({threats: {points: [], count: 1,
        areas: [{region, label: 'Ракета', count: 0, advisory: false}]}});
    // Markup parsing would fail on the first name and draw no item text at all.
    const list = read => countIn(read, 64, 114, 300, 260, bright);
    assertTrue(list(draw(area('A & <b>B'))) > list(draw(area('A'))), 'the markup characters are not drawn');
});

test('long region names stop at three lines', () => {
    const long = Array(40).fill('Довга назва').join(' ');
    // Provider text can hold line breaks, and advisory items add one more line.
    for (const [region, advisory] of [[long, false], [long, true], ['А\nБ\nВ\nГ\nД\nЕ', false]]) {
        const read = draw({threats: {points: [], count: 1, areas: [{region, label: 'Ракета', count: 0, advisory}]}},
            L1080, null);
        // The item starts near y 133; three 14 px lines and the padding end it near y 205.
        assertTrue(countIn(read, 64, 140, 344, 200, p => !near(p, '#0e1722', 40)) > 0, 'no item text');
        assertEqual(countIn(read, 64, 210, 344, 400, p => !near(p, '#0e1722', 2)), 0,
            `text below the third line: ${JSON.stringify(region.slice(0, 12))}, advisory ${advisory}`);
    }
});

// Spec 6.1: 64 px from each edge. On the left, the Ubuntu Dock covers x < 66, and x < 82
// at its largest icon size (docs/decisions/2026-10-23-multi-monitor-mode.md), so the
// text starts at 96.
const LEFT = 96;

test('text stays inside the margins, and right of the Ubuntu Dock', () => {
    const view = {statusLines: ['ДАНІ ЗАСТАРІЛИ', 'Загрози: оновлено 14:05 · 10 повідомл.'], alertsStale: true};
    for (const size of ['1920x1080@1', '3840x2160@2', '2560x1080@1', '1080x1920@1']) {
        const layout = pictureLayout(parseDisplayOverride(size));
        const {width: W, height: H, monitors: [{scale}]} = layout;
        const m = 64 * scale, left = LEFT * scale;
        // Without boundaries only text is drawn, so the margins must stay empty.
        const read = draw(view, layout, null);
        const blank = p => near(p, '#0e1722', 2);
        for (const [x0, y0, x1, y1] of [[0, 0, W, m], [0, H - m, W, H], [0, m, left, H - m], [W - m, m, W, H - m]])
            assertEqual(countIn(read, x0, y0, x1, y1, p => !blank(p)), 0, `${size}: ink in the margin ${[x0, y0, x1, y1]}`);
        assertTrue(countIn(read, left, m, left + 40 * scale, m + 30 * scale, p => !blank(p)) > 0, `${size}: no title`);
        // The legend starts at the left edge of the text area.
        assertTrue(countIn(read, left, H - m - 20 * scale, left + 10 * scale, H - m, p => !blank(p)) > 0,
            `${size}: no legend at x ${left}`);
    }

    // Many three-line items must stop above the legend block, not run into the margin.
    const region = Array(40).fill('Довга назва').join(' ');
    const areas = Array.from({length: 20}, () => ({region, label: 'МіГ-31К', count: 0, advisory: true}));
    const listView = {...view, threats: {points: [], count: 20, areas}};
    const emptyView = {...view, threats: {points: [], count: 0, areas: []}};
    for (const size of ['1920x1080@1', '1366x768@1']) {
        const layout = pictureLayout(parseDisplayOverride(size));
        const {width: W, height: H} = layout;
        const read = draw(listView, layout, null);
        const blank = p => near(p, '#0e1722', 2);
        for (const [x0, y0, x1, y1] of [[0, 0, W, 64], [0, H - 64, W, H], [0, 64, LEFT, H - 64], [W - 64, 64, W, H - 64]])
            assertEqual(countIn(read, x0, y0, x1, y1, p => !blank(p)), 0, `${size} list: ink in the margin ${[x0, y0, x1, y1]}`);
        // From above the legend block down, the picture must be the same as without a list.
        const without = draw(emptyView, layout, null);
        let diff = 0;
        for (let y = H - 64 - 30; y < H; ++y)
            for (let x = 0; x < W; ++x)
                if (read(x, y).some((v, i) => v !== without(x, y)[i])) ++diff;
        assertEqual(diff, 0, `${size}: list ink in the legend block`);
    }
});

test('a group count at the map edge stays inside the 64 px margin', () => {
    // On a 1080x1920 monitor the western map edge is at x 59.4, inside the margin.
    const layout = pictureLayout(parseDisplayOverride('1080x1920@1'));
    const edge = project([bounds[0], 48]);
    const [ex, ey] = screen(mapTransform(bounds, 1080, 1920), edge);
    assertTrue(ex > 50 && ex < 64, `the edge is at x ${ex}`);
    const group = count => draw({threats: {points: [{type: 'uav', point: edge, advisory: false, heading: null, count}],
        areas: [], count: 1}}, layout);
    // Only the label differs between a group of 12 and a single threat.
    const label = group(12), single = group(1);
    const differ = (x0, x1) => {
        let n = 0;
        for (let y = ey - 40; y < ey + 40; ++y)
            for (let x = x0; x < x1; ++x)
                if (label(x, y).some((v, i) => v !== single(x, y)[i])) ++n;
        return n;
    };
    assertTrue(differ(0, 200) > 0, 'no group label');
    assertEqual(differ(0, 64), 0, 'label ink in the left margin');
});

test('the overflow count includes items cut by the height bound', () => {
    // 1366x768: the count limit is 8, but only 6 three-line items (69 px) fit in the
    // 525 px above the legend block with the overflow line (17 px).
    assertEqual(areaListLimit(768 - 128), 8);
    assertDeepEqual(areaListPlan(Array(8).fill(69), 20, 525, 17), {shown: 6, more: 14});
    assertDeepEqual(areaListPlan(Array(3).fill(20), 20, 1000, 17), {shown: 3, more: 17});
    // Without hidden items, no overflow line is needed below the last item.
    assertDeepEqual(areaListPlan([20, 20], 2, 45, 17), {shown: 2, more: 0});
    assertDeepEqual(areaListPlan([69], 20, 30, 17), {shown: 0, more: 20});
});

test('area list limit on portrait', () => { // Review Focus 5
    assertEqual(areaListLimit(1920 - 128), 26);
    assertEqual(areaListLimit(150), 1);
});

test('missing boundaries show the loading message', () => {
    const read = draw({}, L1080, null);
    assertColorNear(read(5, 5), '#0e1722');
    const [x0, y0] = screen(t, [bounds[0], bounds[1]]);
    const [x1, y1] = screen(t, [bounds[2], bounds[3]]);
    for (let y = y0; y <= y1; y += 10)
        for (let x = x0; x <= x1; x += 10)
            assertTrue(!near(read(x, y), '#cf4655', 30), `red at ${x},${y}`);
    // The centered message is drawn in #f2c879.
    assertTrue(countIn(read, 760, 520, 1160, 560, p => near(p, '#f2c879', 20)) > 0, 'no loading message');
});

await run();
