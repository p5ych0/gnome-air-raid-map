// SPDX-License-Identifier: MIT
// The items that the updater needs, and the packages that have them (spec 5.8).
// check-deps.js checks them, and tests/unit/test-check-deps.js tests the table.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

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

// The index of the family of this system in the packages of CHECKS: 0 for the
// Fedora family, 1 for the Debian family, or -1 if not known. path is the
// os-release file; a test gives another one.
export function family(path = '/etc/os-release') {
    try {
        const text = new TextDecoder().decode(GLib.file_get_contents(path)[1]);
        const ids = ['ID', 'ID_LIKE'].flatMap(key =>
            (new RegExp(`^${key}=["']?([^"'\\n]*)`, 'm').exec(text)?.[1] ?? '').split(/\s+/));
        if (ids.some(id => ['fedora', 'rhel', 'centos'].includes(id))) return 0;
        if (ids.some(id => ['debian', 'ubuntu'].includes(id))) return 1;
    } catch (e) {
        // No os-release file: the family is not known.
    }
    return -1;
}
