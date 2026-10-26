// SPDX-License-Identifier: MIT
// Feed state, the view model for render.js, status text and the render key.
import GLib from 'gi://GLib';
import {parseSnapshot, parseThreats, isStale} from './mapdata.js';
import {ROTATING_TYPES} from './symbols.js';

const sha256 = text => GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, text, -1);

export function emptyFeed() {
    return {payload: null, lastSuccess: 0, lastChange: 0, digest: '', error: ''};
}

function acceptFeed(feed, payload, digest, now) {
    return {
        payload,
        lastSuccess: now,
        lastChange: digest !== feed.digest ? now : feed.lastChange,
        digest,
        error: '',
    };
}

export function failFeed(feed, message) {
    return {...feed, error: message};
}

// The digests cover only what the picture draws (spec 4.1, 5.6). Undocumented
// provider fields (version, seq, serverTime), undrawn entry fields and the entry
// order change on every poll. The digests and the render key carry the same
// information, but for alerts they are not literally the same object: the digest
// uses drawnAlerts (sorted entries), the view uses sortedAlerts (sorted maps).
const byJson = items => items.map(item => [JSON.stringify(item), item])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(pair => pair[1]);
const pick = (item, fields) => Object.fromEntries(fields.map(field => [field, item[field]]));

// The parseSnapshot result, already deduplicated with red precedence, as sorted [kind, key, level] entries.
export function drawnAlerts(parsed) {
    const entries = [];
    for (const kind of ['raions', 'oblasts'])
        for (const key of Object.keys(parsed[kind])) entries.push([kind, key, parsed[kind][key]]);
    return byJson(entries);
}

// The parseThreats result without the fields that are not drawn (id, approximate). A
// heading counts only for the types that rotate, and a count only above 1, as in marker.
// The points are sorted: their order only decides which overlapping icon is on top. The
// areas keep the provider's order, which the region-only list shows.
export function drawnThreats(parsed) {
    return {
        points: byJson(parsed.points.map(p => ({
            ...pick(p, ['type', 'point', 'advisory']),
            heading: ROTATING_TYPES.includes(p.type) ? p.heading : null,
            count: p.count > 1 ? p.count : 0,
        }))),
        areas: parsed.areas.map(a => pick(a, ['region', 'label', 'count', 'advisory'])),
        count: parsed.count,
    };
}

// A response that does not pass validation is a failed request. It never
// replaces the last valid data (spec 6.2). Without boundaries no response can
// be fully validated, so none is accepted: the last valid data stays and is stale.
export function acceptAlerts(feed, payload, geometry, now) {
    if (!geometry) return failFeed(feed, 'Boundaries unavailable');
    let alerts;
    try {
        alerts = parseSnapshot(payload, geometry.oblasts, geometry.raions);
    } catch (e) {
        return failFeed(feed, e.message);
    }
    return acceptFeed(feed, payload, sha256(JSON.stringify(drawnAlerts(alerts))), now);
}

export function acceptThreats(feed, payload, now) {
    let threats;
    try {
        threats = parseThreats(payload);
    } catch (e) {
        return failFeed(feed, e.message);
    }
    return acceptFeed(feed, payload, sha256(JSON.stringify(drawnThreats(threats))), now);
}

const clock = ms => GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000)).format('%H:%M');

function tryParse(parse) {
    try {
        return {value: parse(), failed: false};
    } catch (e) {
        return {value: null, failed: true};
    }
}

// parseSnapshot keeps the payload order. Sorted keys keep the entry order out of the render key.
function sortedAlerts(alerts) {
    const sorted = map => Object.fromEntries(Object.keys(map).sort().map(key => [key, map[key]]));
    return {raions: sorted(alerts.raions), oblasts: sorted(alerts.oblasts), count: alerts.count};
}

export function buildView(alertsFeed, threatsFeed, geometry, now, labelMode) {
    const alertsParse = geometry && alertsFeed.payload
        ? tryParse(() => sortedAlerts(parseSnapshot(alertsFeed.payload, geometry.oblasts, geometry.raions)))
        : {value: null, failed: false};
    const threatsParse = threatsFeed.payload
        ? tryParse(() => drawnThreats(parseThreats(threatsFeed.payload)))
        : {value: null, failed: false};
    const alertsStale = alertsParse.failed ||
        isStale(alertsFeed.lastSuccess, now, alertsFeed.error !== '' || !geometry);
    const threatsStale = threatsParse.failed ||
        isStale(threatsFeed.lastSuccess, now, threatsFeed.error !== '');
    const timeOf = feed => clock(labelMode === 'unchanged' ? feed.lastChange : feed.lastSuccess);
    const phrase = labelMode === 'unchanged' ? 'без змін з ' : 'оновлено ';
    const line0 = alertsStale
        ? (alertsFeed.lastSuccess > 0 ? 'ДАНІ ЗАСТАРІЛИ' : 'ОЧІКУВАННЯ ДАНИХ')
        : 'Тривоги: ' + phrase + timeOf(alertsFeed);
    const count = threatsParse.value ? threatsParse.value.count : 0;
    const line1 = threatsStale
        ? 'Загрози: немає актуальних даних'
        : 'Загрози: ' + phrase + timeOf(threatsFeed) + ' · ' + count + ' повідомл.';
    return {
        alerts: alertsParse.value,
        threats: threatsParse.value,
        alertsStale,
        threatsStale,
        statusLines: [line0, line1],
    };
}

// programVersion is in the key: after an update, the new drawing code draws once,
// also in label mode unchanged. The caller gives it, so core/ needs no updater/ import.
export function renderKey(view, layout, geometryVersion, programVersion) {
    return sha256(JSON.stringify([view, layout, geometryVersion, programVersion]));
}
