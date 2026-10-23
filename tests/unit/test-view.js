// SPDX-License-Identifier: MIT
import {test, run, assertEqual, assertDeepEqual, assertTrue} from '../lib/assert.js';
import {emptyFeed, acceptAlerts, acceptThreats, failFeed, buildView, renderKey} from '../../core/view.js';
import {pictureLayout, parseDisplayOverride} from '../../core/layout.js';
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
test('without boundaries alerts are checked only for shape', () => {
    const accepted = acceptAlerts(emptyFeed(), {oblasts: [{key: 'gone'}], raions: []}, null, now);
    assertEqual(accepted.error, '');
    assertEqual(accepted.lastSuccess, now);
    const rejected = acceptAlerts(accepted, {oblasts: null, raions: []}, null, now + 1000);
    assertEqual(rejected.error, 'Invalid alert response');
    assertEqual(rejected.payload, accepted.payload);
    assertEqual(rejected.lastSuccess, now);
    // When the boundaries come back, buildView rejects the unknown key.
    const v = view(accepted);
    assertEqual(v.alerts, null);
    assertTrue(v.alertsStale);
});

await run();
