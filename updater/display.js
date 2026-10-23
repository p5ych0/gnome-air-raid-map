// SPDX-License-Identifier: MIT
// Reads the monitor layout from Mutter.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {parseDisplayOverride} from '../core/layout.js';

const SWAPPING_TRANSFORMS = [1, 3, 5, 7];

export function parseCurrentState(state) {
    const [, physicalMonitors, logicalMonitors, props] = state.recursiveUnpack();
    const mode = props['layout-mode'] === 2 ? 'physical' : 'logical';
    const monitors = logicalMonitors.map(([x, y, scale, transform, primary, ids]) => {
        const id = ids[0][0];
        const physical = physicalMonitors.find(p => p[0][0] === id);
        if (!physical)
            throw new Error(`Monitor ${id} is missing from the display state`);
        const current = physical[1].find(m => m[6]['is-current'] === true);
        if (!current)
            throw new Error(`Monitor ${id} has no current mode`);
        let [width, height] = [current[1], current[2]];
        if (SWAPPING_TRANSFORMS.includes(transform))
            [width, height] = [height, width];
        if (mode === 'logical') {
            width = Math.round(width / scale);
            height = Math.round(height / scale);
        }
        return {x, y, width, height, scale, primary};
    });
    if (monitors.length === 0)
        throw new Error('The display state has no monitors');
    return {mode, monitors};
}

export function readDisplayState() {
    const reply = Gio.DBus.session.call_sync(
        'org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
        'org.gnome.Mutter.DisplayConfig', 'GetCurrentState',
        null, null, Gio.DBusCallFlags.NONE, 2000, null);
    return parseCurrentState(reply);
}

export function currentDisplay() {
    const override = GLib.getenv('AIR_RAID_MAP_DISPLAY');
    return override ? parseDisplayOverride(override) : readDisplayState();
}
