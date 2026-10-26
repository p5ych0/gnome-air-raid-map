// SPDX-License-Identifier: MIT
// Checks the libraries and the settings schema that the updater needs (spec 5.8,
// install step 1). install.sh runs it before it installs anything.
// Usage: gjs -m updater/check-deps.js
// Exit 0: all items load. Exit 1: one line on stderr for each missing item, with
// the package that has it.
import GLib from 'gi://GLib';
import System from 'system';
import {CHECKS, family} from './deps.js';

function packageText([fedora, debian], index) {
    if (index === 0) return fedora;
    if (index === 1) return debian;
    return fedora === debian ? fedora : `${fedora} (Fedora) or ${debian} (Debian, Ubuntu)`;
}

async function main() {
    const index = family();
    let missing = 0;
    for (const {name, packages, load} of CHECKS) {
        try {
            await load();
        } catch (e) {
            ++missing;
            printerr(`gnome-air-raid-map: missing ${name}: install the package ${packageText(packages, index)}`);
        }
    }
    return missing === 0 ? 0 : 1;
}

// A dynamic import completes in the GLib main loop.
const loop = GLib.MainLoop.new(null, false);
let status = 1;
main().then(code => {
    status = code;
}, e => {
    printerr(`gnome-air-raid-map: the dependency check failed: ${e}`);
}).finally(() => loop.quit());
loop.run();
System.exit(status);
