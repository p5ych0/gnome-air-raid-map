// SPDX-License-Identifier: MIT
// One updater run: gjs -m updater/main.js (spec 5.4). The systemd timer starts it.
// Exit 0: the wallpaper shows the current data, or the last data marked as stale.
// Exit 1: a run error, with one line on stderr; systemd then shows the failure banner.
// Variables: AIR_RAID_MAP_LABEL_MODE (updated | unchanged),
// AIR_RAID_MAP_PICTURE_OPTIONS (spanned | zoom), and the variables of
// display.js (AIR_RAID_MAP_DISPLAY) and net.js (AIR_RAID_MAP_API_BASE).
import GLib from 'gi://GLib';
import System from 'system';
import {currentDisplay} from './display.js';
import {apiBase, createSession} from './net.js';
import {runOnce} from './run.js';
import {appPaths} from './store.js';
import {backgroundSettings} from './wallpaper.js';
import {DEFAULT_RELOAD_METHOD} from './writer.js';

const NAME = 'gnome-air-raid-map';

const oneLine = text => String(text).replace(/\s*\n\s*/g, ' ');

// The first allowed value is the default. An unknown value is not a run error:
// the map still updates, so the failure banner would be wrong. Warn and use the default.
function choice(variable, allowed) {
    const value = GLib.getenv(variable);
    if (!value) return allowed[0];
    if (allowed.includes(value)) return value;
    printerr(`${NAME}: warning: ${variable}=${oneLine(value)} is not ${allowed.join(' or ')}; using ${allowed[0]}`);
    return allowed[0];
}

async function main() {
    const result = await runOnce({
        session: createSession(),
        settings: backgroundSettings(),
        display: currentDisplay,
        paths: appPaths(),
        now: Date.now(),
        base: apiBase(),
        labelMode: choice('AIR_RAID_MAP_LABEL_MODE', ['updated', 'unchanged']),
        reloadMethod: DEFAULT_RELOAD_METHOD,
        pictureOptions: choice('AIR_RAID_MAP_PICTURE_OPTIONS', ['spanned', 'zoom']),
    });
    for (const warning of result.warnings)
        printerr(`${NAME}: warning: ${oneLine(warning)}`);
}

// Soup completes its requests in the GLib main loop.
const loop = GLib.MainLoop.new(null, false);
let status = 0;
main().catch(e => {
    status = 1;
    printerr(`${NAME}: ${oneLine(e && e.message !== undefined ? e.message : e)}`);
}).finally(() => loop.quit());
loop.run();
System.exit(status);
