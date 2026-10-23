// SPDX-License-Identifier: MIT
// Helper of scenarios/layouts.sh: sets the scale of each monitor with
// org.gnome.Mutter.DisplayConfig.ApplyMonitorsConfig (method 1, temporary:
// no "Keep these display settings?" dialog and no monitors.xml).
// Usage (in the GNOME session): gjs -m monitors.js <scale> [<scale> ...]
// The scales are for the monitors in the order of --virtual-monitor (connectors
// Meta-0, Meta-1, ...). The first monitor is primary; the monitors are side by
// side from x = 0, top-aligned, in their current modes, not rotated.
// Prints the monitors as the Shell must show them, sorted by x:
// [[x, y, width, height, scale], ...] (Main.layoutManager.monitors units).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const scales = ARGV.map(Number);
if (scales.length === 0 || !scales.every(s => s > 0)) {
    printerr('usage: monitors.js <scale> [<scale> ...]');
    System.exit(2);
}

const call = (method, args, type) => Gio.DBus.session.call_sync(
    'org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
    'org.gnome.Mutter.DisplayConfig', method, args, type ? new GLib.VariantType(type) : null,
    Gio.DBusCallFlags.NONE, 10000, null);

// (u serial, a((ssss)a(siiddada{sv})a{sv}) monitors, a(iiduba(ssss)a{sv}) logical, a{sv} props)
const [serial, monitors, , props] = call('GetCurrentState', null).recursiveUnpack();
// Mutter numbers the connectors of the virtual monitors in the order of the options.
const connectorNumber = monitor => Number(/(\d+)$/.exec(monitor[0][0])?.[1] ?? NaN);
monitors.sort((a, b) => connectorNumber(a) - connectorNumber(b));
if (monitors.length !== scales.length) {
    printerr(`monitors.js: ${monitors.length} monitors, ${scales.length} scales`);
    System.exit(1);
}
// Layout mode 1 is logical (positions in logical pixels), 2 is physical.
const logical = props['layout-mode'] !== 2;

let x = 0;
const expected = [];
const config = monitors.map(([[connector], modes], i) => {
    const mode = modes.find(m => m[6]['is-current']);
    const [id, width, height, , , supported] = mode;
    const scale = scales[i];
    if (!supported.some(s => Math.abs(s - scale) < 1e-6)) {
        printerr(`monitors.js: ${connector} ${id} does not support scale ${scale} (${supported})`);
        System.exit(1);
    }
    const w = logical ? Math.round(width / scale) : width;
    const h = logical ? Math.round(height / scale) : height;
    const entry = [x, 0, scale, 0, i === 0, [[connector, id, {}]]];
    expected.push([x, 0, w, h, scale]);
    x += w;
    return entry;
});

call('ApplyMonitorsConfig', new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})', [serial, 1, config, {}]));
print(JSON.stringify(expected));
