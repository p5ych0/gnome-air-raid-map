// SPDX-License-Identifier: MIT
import {test, run, assertEqual, assertDeepEqual, assertTrue} from '../lib/assert.js';
import {emptyFeed, acceptAlerts, acceptThreats, failFeed, buildView, renderKey} from '../../core/view.js';
import {pictureLayout, parseDisplayOverride} from '../../core/layout.js';
import {prepareGeometry} from '../../core/mapdata.js';
import {syntheticGeometry} from '../lib/fixtures.js';

const now = Date.UTC(2026, 9, 23, 14, 5, 30);
const geometry = syntheticGeometry();
const alertPayload = {oblasts: [{key: 'test'}], raions: []};
const threatPayload = {threats: []};
const fresh = acceptAlerts(emptyFeed(), alertPayload, geometry, now);
const freshThreats = acceptThreats(emptyFeed(), threatPayload, now);
const view = (a, t = freshThreats, mode = 'updated', at = now) => buildView(a, t, geometry, at, mode);

test('fresh alerts show the update time', () => assertEqual(view(fresh).statusLines[0], 'Тривоги: оновлено 14:05'));
test('fresh threats show time and count', () =>
    assertEqual(view(fresh).statusLines[1], 'Загрози: оновлено 14:05 · 0 повідомл.'));
test('unchanged mode shows the change time', () => {
    const feed = {...fresh, lastChange: now - 600000};
    assertEqual(view(feed, freshThreats, 'unchanged').statusLines[0], 'Тривоги: без змін з 13:55');
});
test('failed request is stale at once', () => {
    const v = view(failFeed(fresh, 'HTTP 503'));
    assertEqual(v.statusLines[0], 'ДАНІ ЗАСТАРІЛИ');
    assertTrue(v.alertsStale);
});
test('never loaded is waiting', () => assertEqual(view(emptyFeed()).statusLines[0], 'ОЧІКУВАННЯ ДАНИХ'));
test('90 seconds without success is stale', () => {
    const feed = {...fresh, lastSuccess: now - 90000};
    assertTrue(view(feed).alertsStale);
    assertTrue(!view({...fresh, lastSuccess: now - 89999}).alertsStale);
});
test('threat outage leaves alerts current', () => {
    const v = view(fresh, failFeed(freshThreats, 'HTTP 503'));
    assertTrue(!v.alertsStale);
    assertTrue(v.threatsStale);
    assertEqual(v.statusLines[1], 'Загрози: немає актуальних даних');
});
test('failure keeps the last valid payload', () => {
    const failed = failFeed(fresh, 'HTTP 503');
    assertTrue(failed.payload !== null);
    const v = view(failed);
    assertTrue(v.alerts !== null);
    assertTrue(v.alertsStale);
});
test('invalid payload gives null and stale', () => {
    // The accept functions reject it, but a state file from an older run can hold it.
    const v = view({...fresh, payload: {bad: 1}}, {...freshThreats, payload: {bad: 1}});
    assertEqual(v.alerts, null);
    assertTrue(v.alertsStale);
    assertEqual(v.threats, null);
    assertTrue(v.threatsStale);
});
test('missing geometry makes alerts stale', () => {
    const v = buildView(fresh, freshThreats, null, now, 'updated');
    assertEqual(v.alerts, null);
    assertTrue(v.alertsStale);
});
test('same payload keeps the change time', () => {
    const a = acceptAlerts(emptyFeed(), alertPayload, geometry, 1000);
    const b = acceptAlerts(a, {oblasts: [{key: 'test'}], raions: []}, geometry, 2000);
    assertEqual(b.lastChange, 1000);
    assertEqual(b.lastSuccess, 2000);
    const c = acceptAlerts(b, {oblasts: [], raions: []}, geometry, 3000);
    assertEqual(c.lastChange, 3000);
});
test('updated mode changes the key on a success in a new minute', () => {
    const layout = pictureLayout(parseDisplayOverride('1920x1080@1'));
    const a = acceptAlerts(emptyFeed(), alertPayload, geometry, now);
    const b = acceptAlerts(a, alertPayload, geometry, now + 60000);
    assertEqual(b.lastChange, a.lastChange);
    const key = (feed, mode) => renderKey(view(feed, freshThreats, mode, now + 60000), layout, 'g1');
    assertTrue(key(a, 'updated') !== key(b, 'updated'));
    assertEqual(key(a, 'unchanged'), key(b, 'unchanged'));
});
test('unchanged mode keeps the key without changes', () => {
    const layout = pictureLayout(parseDisplayOverride('1920x1080@1'));
    const later = {...fresh, lastSuccess: now + 60000};
    assertEqual(renderKey(view(fresh, freshThreats, 'unchanged'), layout, 'g1'),
        renderKey(view(later, freshThreats, 'unchanged', now + 60000), layout, 'g1'));
});
test('layout change changes the key', () => {
    const v = view(fresh);
    const l1 = pictureLayout(parseDisplayOverride('1920x1080@1'));
    const l2 = pictureLayout(parseDisplayOverride('2560x1440@1'));
    assertTrue(renderKey(v, l1, 'g1') !== renderKey(v, l2, 'g1'));
    assertTrue(renderKey(v, l1, 'g1') !== renderKey(v, l1, 'g2'));
});

// Two regions, so that alert entries can come in a different order.
function twoRegionGeometry() {
    const square = (key, lon) => ({properties: {key}, geometry: {type: 'Polygon',
        coordinates: [[[lon, 46], [lon + 4, 46], [lon + 4, 50], [lon, 50], [lon, 46]]]}});
    const regions = prepareGeometry({type: 'FeatureCollection', features: [square('a', 24), square('b', 30)]});
    return {oblasts: regions, raions: regions};
}
const unchangedKey = (alerts, threats, g, at) => renderKey(buildView(alerts, threats, g, at, 'unchanged'),
    pictureLayout(parseDisplayOverride('1920x1080@1')), 'g1');

test('threat fields that are not drawn are not a change', () => {
    const entry = {id: 'one', type: 'kab', lat: 50, lon: 30, status: 'active', uncertaintyKm: 5};
    const a = acceptThreats(emptyFeed(), {epoch: 1, seq: 10, serverTime: now, threats: [entry]}, now);
    const b = acceptThreats(a, {epoch: 1, seq: 11, serverTime: now + 30000,
        threats: [{...entry, uncertaintyKm: 8}]}, now + 30000);
    assertEqual(b.lastChange, now);
    assertEqual(unchangedKey(fresh, a, geometry, now + 30000), unchangedKey(fresh, b, geometry, now + 30000));
    const c = acceptThreats(b, {epoch: 1, seq: 12, serverTime: now + 60000,
        threats: [{...entry, lat: 49}]}, now + 60000);
    assertEqual(c.lastChange, now + 60000);
    assertTrue(unchangedKey(fresh, b, geometry, now + 60000) !== unchangedKey(fresh, c, geometry, now + 60000));
});
test('alert fields that are not drawn and the entry order are not a change', () => {
    const two = twoRegionGeometry();
    const a = acceptAlerts(emptyFeed(), {version: 7, updatedAt: '2026-10-23T14:05:00Z',
        oblasts: [{key: 'a'}, {key: 'b', level: 'yellow'}], raions: []}, two, now);
    const b = acceptAlerts(a, {version: 8, updatedAt: '2026-10-23T14:05:30Z',
        oblasts: [{key: 'b', level: 'yellow'}, {key: 'a', level: 'red'}], raions: []}, two, now + 30000);
    assertEqual(b.lastChange, now);
    assertEqual(unchangedKey(a, freshThreats, two, now + 30000), unchangedKey(b, freshThreats, two, now + 30000));
    const c = acceptAlerts(b, {version: 9, updatedAt: '2026-10-23T14:06:30Z',
        oblasts: [{key: 'b', level: 'yellow'}, {key: 'a', level: 'yellow'}], raions: []}, two, now + 60000);
    assertEqual(c.lastChange, now + 60000);
    assertTrue(unchangedKey(b, freshThreats, two, now + 60000) !== unchangedKey(c, freshThreats, two, now + 60000));
});

test('duplicate alert keys and yellow beside red are not a change', () => {
    const two = twoRegionGeometry();
    const clean = acceptAlerts(emptyFeed(), {oblasts: [{key: 'a'}, {key: 'b', level: 'yellow'}], raions: []}, two, now);
    // parseSnapshot draws one entry per key, and red wins over yellow.
    const noisy = acceptAlerts(clean, {oblasts: [{key: 'a', level: 'yellow'}, {key: 'a'}, {key: 'a', level: 'yellow'},
        {key: 'b', level: 'yellow'}, {key: 'b', level: 'yellow'}], raions: []}, two, now + 30000);
    assertEqual(noisy.digest, clean.digest);
    assertEqual(noisy.lastChange, now);
    assertEqual(unchangedKey(noisy, freshThreats, two, now + 30000), unchangedKey(clean, freshThreats, two, now + 30000));
});

const uavGroup = {id: 'one', type: 'uav', lat: 50, lon: 30, status: 'active', heading: 90, count: 2,
    positionQuality: 'confirmed'};
const kab = {id: 'two', type: 'kab', lat: 48, lon: 34, status: 'active'};
const north = {id: 'north', type: 'missile', status: 'active', areaOnly: true, region: 'Північна область'};
const south = {id: 'south', type: 'kab', status: 'active', areaOnly: true, region: 'Південна область', count: 3};
const threatsAt = (feed, threats, at) => acceptThreats(feed, {threats}, at);

test('threat ids, position quality and the point order are not a change', () => {
    const a = threatsAt(emptyFeed(), [uavGroup, kab, north, south], now);
    const key = feed => unchangedKey(fresh, feed, geometry, now + 30000);
    for (const [name, threats] of Object.entries({
        'point id': [{...uavGroup, id: 'renamed'}, kab, north, south],
        'area id': [uavGroup, kab, {...north, id: 'renamed'}, south],
        'position quality': [{...uavGroup, positionQuality: 'approx'}, kab, north, south],
        'point order': [kab, north, uavGroup, south],
    })) {
        const b = threatsAt(a, threats, now + 30000);
        assertEqual(b.digest, a.digest, `${name}: digest`);
        assertEqual(b.lastChange, now, `${name}: change time`);
        assertEqual(key(b), key(a), `${name}: render key`);
    }
});

test('a heading on a type that does not rotate and a count of 1 are not a change', () => {
    const base = [{...uavGroup, count: 0}, {...kab, heading: 45}, north, south];
    const a = threatsAt(emptyFeed(), base, now);
    const key = feed => unchangedKey(fresh, feed, geometry, now + 30000);
    for (const [name, threats] of Object.entries({
        'kab heading': [{...uavGroup, count: 0}, {...kab, heading: 200}, north, south],
        'kab without heading': [{...uavGroup, count: 0}, kab, north, south],
        'count 1 instead of 0': [{...uavGroup, count: 1}, {...kab, heading: 45}, north, south],
    })) {
        const b = threatsAt(a, threats, now + 30000);
        assertEqual(b.digest, a.digest, `${name}: digest`);
        assertEqual(b.lastChange, now, `${name}: change time`);
        assertEqual(key(b), key(a), `${name}: render key`);
    }
});

test('a drawn threat change is a change', () => {
    const a = threatsAt(emptyFeed(), [uavGroup, kab, north, south], now);
    const key = feed => unchangedKey(fresh, feed, geometry, now + 30000);
    for (const [name, threats] of Object.entries({
        'heading': [{...uavGroup, heading: 180}, kab, north, south],
        'point count': [{...uavGroup, count: 5}, kab, north, south],
        'area count': [uavGroup, kab, north, {...south, count: 4}],
        // The region-only list shows the provider's order.
        'area order': [uavGroup, kab, south, north],
    })) {
        const b = threatsAt(a, threats, now + 30000);
        assertTrue(b.digest !== a.digest, `${name}: same digest`);
        assertEqual(b.lastChange, now + 30000, `${name}: change time`);
        assertTrue(key(b) !== key(a), `${name}: same render key`);
    }
});

// Ported from the Plasma project: tests/tst_threatsource.qml.
test('invalid snapshot preserves last valid threats', () => {
    const first = acceptThreats(emptyFeed(),
        {threats: [{id: 'one', type: 'kab', lat: 50, lon: 30, status: 'active'}]}, now);
    assertTrue(!view(fresh, first).threatsStale);
    const rejected = acceptThreats(first, {threats: null}, now + 1000);
    assertEqual(rejected.error, 'Invalid threat response');
    assertEqual(rejected.payload, first.payload);
    assertEqual(rejected.lastSuccess, now);
    assertEqual(view(fresh, rejected, 'updated', now + 1000).threats.points[0].type, 'kab');
    const next = acceptThreats(rejected, {threats: []}, now + 2000);
    assertEqual(next.lastSuccess, now + 2000);
    assertEqual(view(fresh, next, 'updated', now + 2000).threats.points.length, 0);
});
test('endpoints have independent freshness and recovery', () => {
    const noKeys = {oblasts: {keys: {}}, raions: {keys: {}}};
    let alerts = acceptAlerts(emptyFeed(), {oblasts: [], raions: []}, noKeys, now);
    let threats = acceptThreats(emptyFeed(), {threats: []}, now);
    const stale = (at = now) => {
        const v = buildView(alerts, threats, noKeys, at, 'updated');
        return [v.alertsStale, v.threatsStale];
    };
    assertDeepEqual(stale(), [false, false]);
    threats = failFeed(threats, 'HTTP 503');
    assertDeepEqual(stale(), [false, true]);
    threats = acceptThreats(threats, {threats: []}, now);
    assertDeepEqual(stale(), [false, false]);
    alerts = failFeed(alerts, 'Network timeout');
    assertDeepEqual(stale(), [true, false]);
    assertDeepEqual(stale(threats.lastSuccess + 90000), [true, true]);
});

test('alerts with a key outside the boundaries keep the last valid alerts', () => {
    const rejected = acceptAlerts(fresh, {oblasts: [{key: 'gone'}], raions: []}, geometry, now + 1000);
    assertEqual(rejected.error, 'Alert region missing from map boundaries');
    assertEqual(rejected.payload, fresh.payload);
    assertEqual(rejected.lastSuccess, now);
    const v = view(rejected, freshThreats, 'updated', now + 1000);
    assertTrue(v.alertsStale);
    assertEqual(v.alerts.oblasts['@test'], 'red');
});
// Without boundaries no alert response can be fully validated, so none is accepted.
const keepsLastValid = (feed, payload) => {
    const rejected = acceptAlerts(feed, payload, null, now + 1000);
    assertEqual(rejected.error, 'Boundaries unavailable');
    assertEqual(rejected.payload, feed.payload);
    assertEqual(rejected.lastSuccess, feed.lastSuccess);
    assertEqual(rejected.lastChange, feed.lastChange);
    return rejected;
};
test('without boundaries a malformed alert response keeps the last valid alerts', () => {
    const rejected = keepsLastValid(fresh, {oblasts: [{key: 'test', level: 'blue'}], raions: []});
    const v = view(rejected, freshThreats, 'updated', now + 1000);
    assertTrue(v.alertsStale);
    assertEqual(v.alerts.oblasts['@test'], 'red');
});
test('without boundaries a well-formed alert response is not accepted', () =>
    keepsLastValid(fresh, {oblasts: [{key: 'test', level: 'yellow'}], raions: []}));
test('without boundaries on the first run alerts are waiting', () => {
    const rejected = keepsLastValid(emptyFeed(), alertPayload);
    assertEqual(rejected.payload, null);
    assertEqual(rejected.lastSuccess, 0);
    assertEqual(buildView(rejected, freshThreats, null, now + 1000, 'updated').statusLines[0], 'ОЧІКУВАННЯ ДАНИХ');
});

test('undefined boundaries make a fresh alerts feed stale, like null boundaries', () => {
    const v = buildView(fresh, freshThreats, undefined, now, 'updated');
    assertTrue(v.alertsStale);
    assertTrue(!v.statusLines[0].startsWith('Тривоги: оновлено'));
});

await run();
