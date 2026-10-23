#!/usr/bin/env bash
# Downloads the files of the leak checks from NEPTUN into tests/leak/.cache/
# (plan Task 11). The folder is in .gitignore: the repository must not include
# the NEPTUN boundary files (spec 4.1). Never commit these files.
# Usage: tests/leak/fetch-geometry.sh
# Files: oblasts.geojson, raions.geojson, threats.json (from /api/v1/threats),
# alerts-a.json (no alerts) and alerts-b.json (every oblast red). The two alert
# files always differ, so a fixture server that serves them in turn makes every
# run of the updater draw a new picture.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cache="$here/.cache"
base=${AIR_RAID_MAP_API_BASE:-https://neptun.in.ua}
base=${base%/}
mkdir -p "$cache"

# get <path> <file>: one GET request, gzip allowed. A partial file never stays.
get() {
    curl --fail --silent --show-error --compressed --max-time 60 \
        --user-agent 'gnome-air-raid-map-leak-check' -o "$cache/$2.tmp" "$base$1"
    mv "$cache/$2.tmp" "$cache/$2"
}
get /oblasts.geojson oblasts.geojson
get /raions.geojson raions.geojson
get /api/v1/threats threats.json

gjs -c '
    const GLib = imports.gi.GLib;
    const dir = ARGV[0];
    const path = name => GLib.build_filenamev([dir, name]);
    const oblasts = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(path("oblasts.geojson"))[1]));
    const keys = oblasts.features.map(f => f.properties.key);
    if (keys.length === 0) throw new Error("oblasts.geojson has no features");
    GLib.file_set_contents(path("alerts-a.json"), JSON.stringify({raions: [], oblasts: []}));
    GLib.file_set_contents(path("alerts-b.json"),
        JSON.stringify({raions: [], oblasts: keys.map(key => ({key, level: "red"}))}));
    print(`${keys.length} oblasts`);' "$cache"
ls -l "$cache"
