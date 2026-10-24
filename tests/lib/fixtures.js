// SPDX-License-Identifier: MIT
// Synthetic map data from the Plasma project's tests/preview-threats.qml.
import {prepareGeometry, parseSnapshot, parseThreats} from '../../core/mapdata.js';

// The GeoJSON of one square region, as a server sends it.
export function syntheticCollection() {
    return {type: 'FeatureCollection', features: [{
        properties: {key: 'test', region: 'SYNTHETIC TEST DATA'},
        geometry: {type: 'Polygon', coordinates: [[[22, 44], [40, 44], [40, 52], [22, 52], [22, 44]]]},
    }]};
}

// One square region, used as the oblasts and as the raions.
export function syntheticGeometry() {
    const oblasts = prepareGeometry(syntheticCollection());
    return {oblasts, raions: oblasts};
}

// Every symbol type, one group count, one heading, one advisory point, and two region-only reports.
export function syntheticThreats() {
    const types = ['uav', 'fpv', 'recon', 'missile', 'ballistic', 'kab', 'mig31k', 'unknown'];
    const entries = types.map((type, i) => ({
        id: type, type, status: 'active', lon: 25 + (i % 4) * 4,
        lat: i < 4 ? 49 : 46, heading: i === 0 ? 90 : null,
        count: i === 0 ? 3 : 0, advisory: type === 'mig31k',
        positionQuality: type === 'fpv' ? 'approx' : 'confirmed',
    }));
    entries.push({id: 'area', type: 'missile', status: 'active', areaOnly: true,
        region: 'Тестова область', heading: 180});
    entries.push({id: 'advisory', type: 'mig31k', status: 'active', areaOnly: true,
        region: 'Інша область', advisory: true});
    return entries;
}

// A fresh view with a red alert on the square and all synthetic threats.
export function syntheticView(overrides = {}) {
    const geometry = syntheticGeometry();
    const threats = parseThreats({threats: syntheticThreats()});
    return {
        alerts: parseSnapshot({oblasts: [{key: 'test'}], raions: []}, geometry.oblasts, geometry.raions),
        threats,
        alertsStale: false,
        threatsStale: false,
        statusLines: ['Тривоги: оновлено 14:05', `Загрози: оновлено 14:05 · ${threats.count} повідомл.`],
        ...overrides,
    };
}
