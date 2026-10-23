// SPDX-License-Identifier: MIT
import {test, run, assertEqual, assertDeepEqual, assertTrue, assertThrows} from '../lib/assert.js';
import {project, prepareGeometry, parseSnapshot, isStale, parseThreats, STALE_AFTER_MS}
    from '../../core/mapdata.js';

// Alert data

function geometry(key) {
    return prepareGeometry({type: 'FeatureCollection', features: [{
        type: 'Feature', properties: {key, region: 'Test region'},
        geometry: {type: 'Polygon', coordinates: [[[29, 49], [31, 49], [31, 51], [29, 49]]]},
    }]});
}

test('stale limit is 90 seconds', () => assertEqual(STALE_AFTER_MS, 90000));

test('raionAndOblastKeysAreSeparate', () => {
    const model = geometry('test');
    const alerts = parseSnapshot({raions: [{key: 'test', level: 'yellow'}], oblasts: []}, model, model);
    assertEqual(alerts.raions['@test'], 'yellow');
    assertEqual(alerts.oblasts['@test'], undefined);
    assertEqual(alerts.count, 1);
});

test('fullSnapshotClearsEndedAlerts', () => {
    const model = geometry('test');
    let alerts = parseSnapshot({raions: [{key: 'test'}], oblasts: []}, model, model);
    assertEqual(alerts.raions['@test'], 'red');
    alerts = parseSnapshot({raions: [], oblasts: []}, model, model);
    assertEqual(alerts.raions['@test'], undefined);
    assertEqual(alerts.count, 0);
});

for (const row of [
    {tag: 'missing-array', payload: {raions: []}},
    {tag: 'not-an-array', payload: {raions: {}, oblasts: []}},
    {tag: 'unknown-region', payload: {raions: [{key: 'missing'}], oblasts: []}},
    {tag: 'unknown-level', payload: {raions: [{key: 'test', level: 'green'}], oblasts: []}},
]) {
    test(`invalidResponsesCannotBecomeAllClear: ${row.tag}`, () => {
        const model = geometry('test');
        assertThrows(() => parseSnapshot(row.payload, model, model));
    });
}

test('staleDataIsNeverPresentedAsCurrent', () => {
    assertTrue(isStale(0, 100000, false));
    assertTrue(!isStale(1000, 30000, false));
    assertTrue(isStale(1000, 30000, true));
    assertTrue(isStale(1000, 91000, false));
});

test('multipolygonPreservesIslandsAndHoles', () => {
    const model = prepareGeometry({type: 'FeatureCollection', features: [{
        properties: {key: 'islands'}, geometry: {type: 'MultiPolygon', coordinates: [
            [[[29, 49], [31, 49], [31, 51], [29, 49]], [[30, 49.5], [30.5, 49.5], [30, 50], [30, 49.5]]],
            [[[32, 49], [33, 49], [33, 50], [32, 49]]],
        ]},
    }]});
    assertEqual(model.regions[0].polygons.length, 2);
    assertEqual(model.regions[0].polygons[0].length, 2);
    assertEqual(model.bounds[0], 29);
    assertEqual(model.bounds[2], 33);
    assertTrue(model.bounds[3] > model.bounds[1]);
});

// Threat data

function threat(overrides) {
    return Object.assign({id: 'one', type: 'uav', lat: 50, lon: 30,
                          status: 'active', heading: null}, overrides || {});
}

for (const type of ['uav', 'fpv', 'recon', 'missile', 'ballistic', 'kab', 'mig31k', 'unknown']) {
    test(`typesAndCounts: ${type}`, () => {
        const result = parseThreats({threats: [threat({type, count: 3})]});
        assertEqual(result.points.length, 1);
        assertEqual(result.points[0].type, type);
        assertEqual(result.points[0].count, 3);
        assertDeepEqual(result.points[0].point, project([30, 50]));
        assertTrue(result.points[0].label.length > 0);
    });
}

test('regionOnlyReportNeverBecomesAPoint', () => {
    const result = parseThreats({threats: [threat({areaOnly: true,
        region: 'Одеська область', heading: 42, advisory: true, type: 'mig31k'})]});
    assertEqual(result.points.length, 0);
    assertEqual(result.areas.length, 1);
    assertEqual(result.areas[0].region, 'Одеська область');
    assertEqual(result.areas[0].point, null);
    assertEqual(result.areas[0].heading, null);
    assertTrue(result.areas[0].advisory);
});

test('fullSnapshotRemovesFinishedThreats', () => {
    const result = parseThreats({threats: [threat(), threat({id: 'two', status: 'stale'}),
        threat({id: 'three', status: 'resolved'})]});
    assertEqual(result.points.length, 1);
    assertEqual(parseThreats({threats: []}).points.length, 0);
});

test('optionalAndNewProviderFields', () => {
    const entry = parseThreats({threats: [threat({type: 'future-type', heading: -90, count: 0})]}).points[0];
    assertEqual(entry.type, 'unknown');
    assertEqual(entry.heading, 270);
    assertEqual(entry.count, 0);
    assertTrue(!entry.advisory);
    assertTrue(!entry.approximate);
    const approximate = parseThreats({threats: [threat({positionQuality: 'approx'})]}).points[0];
    assertTrue(approximate.approximate);
    assertEqual(approximate.heading, null);
    const presumed = parseThreats({threats: [threat({heading: 45, presumptiveCourse: true})]}).points[0];
    assertEqual(presumed.heading, null);
});

for (const row of [
    {tag: 'missing-array', payload: {}},
    {tag: 'bad-coordinate', payload: {threats: [threat({lat: '50'})]}},
    {tag: 'coordinate-range', payload: {threats: [threat({lon: 200})]}},
    {tag: 'duplicate-id', payload: {threats: [threat(), threat()]}},
    {tag: 'unknown-status', payload: {threats: [threat({status: 'future'})]}},
    {tag: 'bad-area-flag', payload: {threats: [threat({areaOnly: 'true'})]}},
    {tag: 'missing-region', payload: {threats: [threat({areaOnly: true})]}},
]) {
    test(`malformedSnapshotIsNotAnEmptyMap: ${row.tag}`, () => {
        assertThrows(() => parseThreats(row.payload));
    });
}

await run();
