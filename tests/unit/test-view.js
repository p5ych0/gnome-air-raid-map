// SPDX-License-Identifier: MIT
import {test, run, assertEqual, assertTrue} from '../lib/assert.js';
import {emptyFeed, acceptFeed, failFeed, buildView, renderKey} from '../../core/view.js';
import {pictureLayout, parseDisplayOverride} from '../../core/layout.js';
import {syntheticGeometry} from '../lib/fixtures.js';

const now = Date.UTC(2026, 9, 23, 14, 5, 30);
const geometry = syntheticGeometry();
const alertPayload = {oblasts: [{key: 'test'}], raions: []};
const threatPayload = {threats: []};
const fresh = acceptFeed(emptyFeed(), alertPayload, now);
const freshThreats = acceptFeed(emptyFeed(), threatPayload, now);
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
    const v = view(acceptFeed(emptyFeed(), {bad: 1}, now), acceptFeed(emptyFeed(), {bad: 1}, now));
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
    const a = acceptFeed(emptyFeed(), alertPayload, 1000);
    const b = acceptFeed(a, {oblasts: [{key: 'test'}], raions: []}, 2000);
    assertEqual(b.lastChange, 1000);
    assertEqual(b.lastSuccess, 2000);
    const c = acceptFeed(b, {oblasts: [], raions: []}, 3000);
    assertEqual(c.lastChange, 3000);
});
test('updated mode changes the key on a success in a new minute', () => {
    const layout = pictureLayout(parseDisplayOverride('1920x1080@1'));
    const a = acceptFeed(emptyFeed(), alertPayload, now);
    const b = acceptFeed(a, alertPayload, now + 60000);
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

await run();
