// SPDX-License-Identifier: MIT
// Feed state, the view model for render.js, status text and the render key.
import GLib from 'gi://GLib';
import {parseSnapshot, parseThreats, isStale} from './mapdata.js';

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

// The digests cover only what the picture draws. Undocumented provider fields
// (version, seq, serverTime) and undrawn entry fields change on every poll
// (spec 4.1). Alerts: the sorted [kind, key, level] entries.
function alertsDigest(payload) {
    const entries = [];
    for (const kind of ['raions', 'oblasts']) {
        for (const entry of payload[kind]) {
            const level = entry && entry.level !== undefined ? entry.level : 'red';
            entries.push(JSON.stringify([kind, entry && entry.key, level]));
        }
    }
    return sha256(JSON.stringify(entries.sort()));
}

// A response that does not pass validation is a failed request. It never
// replaces the last valid data (spec 6.2). Without boundaries no response can
// be fully validated, so none is accepted: the last valid data stays and is stale.
export function acceptAlerts(feed, payload, geometry, now) {
    if (!geometry) return failFeed(feed, 'Boundaries unavailable');
    try {
        parseSnapshot(payload, geometry.oblasts, geometry.raions);
    } catch (e) {
        return failFeed(feed, e.message);
    }
    return acceptFeed(feed, payload, alertsDigest(payload), now);
}

export function acceptThreats(feed, payload, now) {
    let threats;
    try {
        threats = parseThreats(payload);
    } catch (e) {
        return failFeed(feed, e.message);
    }
    return acceptFeed(feed, payload, sha256(JSON.stringify(threats)), now);
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
        ? tryParse(() => parseThreats(threatsFeed.payload))
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

export function renderKey(view, layout, geometryVersion) {
    return sha256(JSON.stringify([view, layout, geometryVersion]));
}
