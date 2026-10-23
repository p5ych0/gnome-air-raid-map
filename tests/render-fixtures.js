// SPDX-License-Identifier: MIT
// Writes the visual fixtures: gjs -m tests/render-fixtures.js <out-dir>
import GLib from 'gi://GLib';
import System from 'system';
import {pictureLayout, parseDisplayOverride} from '../core/layout.js';
import {renderPicture} from '../core/render.js';
import {syntheticGeometry, syntheticView} from './lib/fixtures.js';

const SIZES = ['1920x1080@1', '3840x2160@2', '2560x1080@1', '1080x1920@1'];
const STATES = {
    'symbols': {},
    'threat-outage': {threatsStale: true},
    // An alerts error keeps the last valid alerts, dimmed.
    'alerts-stale': {alertsStale: true},
};

const outDir = ARGV[0];
if (!outDir) {
    printerr('usage: gjs -m tests/render-fixtures.js <out-dir>');
    System.exit(2);
}
GLib.mkdir_with_parents(outDir, 0o755);

const geometry = syntheticGeometry();
for (const size of SIZES) {
    const layout = pictureLayout(parseDisplayOverride(size));
    for (const [state, overrides] of Object.entries(STATES)) {
        const view = syntheticView(overrides);
        view.statusLines = [
            view.alertsStale ? 'ДАНІ ЗАСТАРІЛИ' : view.statusLines[0],
            view.threatsStale ? 'Загрози: немає актуальних даних' : view.statusLines[1],
        ];
        const path = `${outDir}/${size}-${state}.png`;
        const surface = renderPicture(layout, geometry, view);
        surface.writeToPNG(path);
        surface.finish();
        print(path);
    }
}
