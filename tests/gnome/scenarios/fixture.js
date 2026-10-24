// SPDX-License-Identifier: MIT
// Helper of scenarios/layouts.sh: writes the files of tests/lib/fixture-server.js,
// so that every run draws the same picture without NEPTUN.
// Usage: gjs -m fixture.js <dir> [<boundaries-dir>]
// Without <boundaries-dir>: the synthetic square of tests/lib/fixtures.js with a
// red alert. With it: its oblasts.geojson and raions.geojson (for example a copy of
// the NEPTUN files; never commit them), with a red alert on every third oblast and
// a yellow alert on the oblast after it. Both: the synthetic threats, and the same
// alerts in alerts-a.json and alerts-b.json.
import GLib from 'gi://GLib';
import {syntheticCollection, syntheticThreats} from '../../lib/fixtures.js';

const [dir, boundaries] = ARGV;
const write = (name, text) => GLib.file_set_contents(GLib.build_filenamev([dir, name]), text);
const read = name => new TextDecoder().decode(GLib.file_get_contents(GLib.build_filenamev([boundaries, name]))[1]);

GLib.mkdir_with_parents(dir, 0o700);
let alerts;
if (boundaries) {
    const oblasts = read('oblasts.geojson');
    write('oblasts.geojson', oblasts);
    write('raions.geojson', read('raions.geojson'));
    const keys = JSON.parse(oblasts).features.map(f => f.properties.key);
    alerts = {raions: [], oblasts: keys.flatMap((key, i) =>
        i % 3 === 2 ? [] : [{key, level: i % 3 === 0 ? 'red' : 'yellow'}])};
} else {
    const square = JSON.stringify(syntheticCollection());
    write('oblasts.geojson', square);
    write('raions.geojson', square);
    alerts = {oblasts: [{key: 'test'}], raions: []};
}
write('alerts-a.json', JSON.stringify(alerts));
write('alerts-b.json', JSON.stringify(alerts));
write('threats.json', JSON.stringify({threats: syntheticThreats()}));
