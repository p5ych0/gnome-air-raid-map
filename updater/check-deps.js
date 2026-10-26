// SPDX-License-Identifier: MIT
// Checks the libraries and the settings schema that the updater needs (spec 5.8,
// install step 1). install.sh runs it before it installs anything.
// Usage: gjs -m updater/check-deps.js
// Exit 0: all items load. Exit 1: one line on stderr for each missing item, with
// the package that has it.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const SCHEMA = 'org.gnome.desktop.background';

// The packages for each distribution family: [Fedora, Debian and Ubuntu]. Each
// package must have the file that the check loads (tests/unit/test-check-deps.js).
export const CHECKS = [
    {name: 'Soup 3.0', packages: ['libsoup3', 'gir1.2-soup-3.0'],
        load: () => import('gi://Soup?version=3.0')},
    {name: 'Pango', packages: ['pango', 'gir1.2-pango-1.0'],
        load: () => import('gi://Pango')},
    {name: 'PangoCairo', packages: ['pango', 'gir1.2-pango-1.0'],
        load: () => import('gi://PangoCairo')},
    {name: 'cairo', packages: ['gobject-introspection', 'gir1.2-freedesktop'],
        load: async () => {
            const {default: Cairo} = await import('cairo');
            new Cairo.ImageSurface(Cairo.Format.RGB24, 1, 1).finish();
        }},
    {name: `the settings schema ${SCHEMA}`, packages: ['gsettings-desktop-schemas', 'gsettings-desktop-schemas'],
        load: () => {
            // new Gio.Settings aborts the process if the schema is missing.
            const source = Gio.SettingsSchemaSource.get_default();
            if (!source || !source.lookup(SCHEMA, true)) throw new Error('not installed');
        }},
];

// 0 for the Fedora family, 1 for the Debian family, or -1 if not known.
function family() {
    try {
        const text = new TextDecoder().decode(GLib.file_get_contents('/etc/os-release')[1]);
        const ids = ['ID', 'ID_LIKE'].flatMap(key =>
            (new RegExp(`^${key}=["']?([^"'\\n]*)`, 'm').exec(text)?.[1] ?? '').split(/\s+/));
        if (ids.some(id => ['fedora', 'rhel', 'centos'].includes(id))) return 0;
        if (ids.some(id => ['debian', 'ubuntu'].includes(id))) return 1;
    } catch (e) {
        // No /etc/os-release: name the packages of both families.
    }
    return -1;
}

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

// The check runs only as a script: a test imports CHECKS.
if (GLib.path_get_basename(System.programInvocationName) === 'check-deps.js') {
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
}
