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

// A response that does not pass validation is a failed request. It never
// replaces the last valid data (spec 6.2). Without boundaries only the shape
// can be checked; buildView checks the keys when the boundaries are back.
export function acceptAlerts(feed, payload, geometry, now) {
    try {
        if (geometry)
            parseSnapshot(payload, geometry.oblasts, geometry.raions);
        else if (!payload || !Array.isArray(payload.raions) || !Array.isArray(payload.oblasts))
            throw new Error('Invalid alert response');
    } catch (e) {
        return failFeed(feed, e.message);
    }
    return acceptFeed(feed, payload, sha256(JSON.stringify(payload)), now);
}

export function acceptThreats(feed, payload, now) {
    try {
        parseThreats(payload);
    } catch (e) {
        return failFeed(feed, e.message);
    }
    return acceptFeed(feed, payload, sha256(JSON.stringify(payload)), now);
}

const clock = ms => GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000)).format('%H:%M');

function tryParse(parse) {
    try {
        return {value: parse(), failed: false};
    } catch (e) {
        return {value: null, failed: true};
    }
}

export function buildView(alertsFeed, threatsFeed, geometry, now, labelMode) {
    const alertsParse = geometry && alertsFeed.payload
        ? tryParse(() => parseSnapshot(alertsFeed.payload, geometry.oblasts, geometry.raions))
        : {value: null, failed: false};
    const threatsParse = threatsFeed.payload
        ? tryParse(() => parseThreats(threatsFeed.payload))
        : {value: null, failed: false};
    const alertsStale = alertsParse.failed ||
        isStale(alertsFeed.lastSuccess, now, alertsFeed.error !== '' || geometry === null);
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
