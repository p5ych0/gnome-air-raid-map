// SPDX-License-Identifier: MIT
// The GNOME wallpaper settings (spec 5.6 and 5.7).
import Gio from 'gi://Gio';

const SCHEMA = 'org.gnome.desktop.background';

// The keys that the install saves and the uninstall puts back (spec 5.8).
export const KEYS = ['picture-uri', 'picture-uri-dark', 'picture-options', 'primary-color'];

export function backgroundSettings() {
    // new Gio.Settings aborts the process if the schema is missing, so check first.
    const source = Gio.SettingsSchemaSource.get_default();
    if (!source || !source.lookup(SCHEMA, true))
        throw new Error(`The settings schema ${SCHEMA} is not installed`);
    return new Gio.Settings({schema_id: SCHEMA});
}

// True if picture-uri and picture-uri-dark both point to uri.
export function showsPicture(settings, uri) {
    return settings.get_string('picture-uri') === uri && settings.get_string('picture-uri-dark') === uri;
}

// Points the wallpaper to uri with picture-options `options`. Writes only the keys
// that differ, in one change: when picture-uri and picture-uri-dark change in two
// writes, GNOME Shell starts to load the first picture and then destroys it
// (docs/decisions/2026-10-23-picture-reload-method.md). This also puts the live
// picture back after the failure banner. Puts `settings` in delay-apply mode.
// Returns true if it changed a key. Throws if a key that must change is locked.
export function applyLive(settings, uri, options = 'spanned') {
    const values = {'picture-uri': uri, 'picture-uri-dark': uri, 'picture-options': options};
    const changes = Object.entries(values).filter(([key, value]) => settings.get_string(key) !== value);
    if (changes.length === 0) return false;
    // In delay-apply mode set_string accepts every key, and apply() drops a locked key
    // without an error. So check first.
    for (const [key] of changes) {
        if (!settings.is_writable(key))
            throw new Error(`Cannot set the wallpaper: ${key} is not writable`);
    }
    settings.delay();
    for (const [key, value] of changes)
        settings.set_string(key, value);
    settings.apply();
    Gio.Settings.sync();
    return true;
}
