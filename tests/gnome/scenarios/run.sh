# Scenario: three runs of the updater against the NEPTUN API, 30 s apart, as the
# systemd timer starts them (plan Task 8). Sourced by session.sh.
# Each run is a new process and must end within TimeoutStartSec=25s of the service.
# For each run it prints one line: the exit status, the run time, the start time,
# whether the picture changed, and from the state file the time of the last valid
# alerts and threats (the corner of the picture shows this time as HH:MM).
# Files: run-<n>.png (screenshot), picture-<n>.png, run-<n>.stderr, state.json.
# GNOME_TEST_RUNS and GNOME_TEST_INTERVAL change the number of runs (3) and the
# seconds from one run start to the next (30).
RUNS=${GNOME_TEST_RUNS:-3}
INTERVAL=${GNOME_TEST_INTERVAL:-30}
DIR=$XDG_RUNTIME_DIR/gnome-air-raid-map
status=0

# The path of the live picture, from the state file of the updater.
live_picture() {
    gjs -c '
        const GLib = imports.gi.GLib;
        print(JSON.parse(new TextDecoder().decode(GLib.file_get_contents(ARGV[0])[1])).picture);' \
        "$DIR/state.json" 2> /dev/null
}

picture_hash() {
    local picture
    picture=$(live_picture) && [ -f "$picture" ] && md5sum < "$picture"
}

# One line from the state file of the updater.
summary() {
    gjs -c '
        const GLib = imports.gi.GLib;
        const state = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(ARGV[0])[1]));
        const at = ms => ms ? GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000)).format("%H:%M:%S") : "never";
        const feed = f => at(f.lastSuccess) + (f.error ? ` (${f.error})` : "");
        print(`alerts ${feed(state.alerts)}, threats ${feed(state.threats)}, ` +
            `layout ${state.layout.width}x${state.layout.height}`);' "$1"
}

for ((n = 1; n <= RUNS; n++)); do
    start=$(date +%s%N)
    clock=$(date +%H:%M:%S)
    before=$(picture_hash)
    # timeout stops the run as TimeoutStartSec=25s does (exit status 124).
    timeout 25 gjs -m /repo/updater/main.js 2> "$OUT/run-$n.stderr"
    code=$?
    ms=$((($(date +%s%N) - start) / 1000000))
    after=$(picture_hash)
    if [ "$before" = "$after" ]; then drew=no; else drew=yes; fi
    [ $code -eq 0 ] || status=1
    line="run $n: exit $code, $ms ms, start $clock, new picture $drew"
    [ -f "$DIR/state.json" ] && line+=", $(summary "$DIR/state.json")"
    echo "$line"
    echo "#   picture-uri $(gsettings get org.gnome.desktop.background picture-uri)," \
        "picture-options $(gsettings get org.gnome.desktop.background picture-options)"
    sed 's/^/#   stderr: /' "$OUT/run-$n.stderr"
    cp "$(live_picture)" "$OUT/picture-$n.png" 2> /dev/null
    # The Shell shows a new picture in less than 0.4 s (docs/decisions/2026-10-23-picture-reload-method.md).
    sleep 2
    screenshot "$OUT/run-$n.png" || status=1
    if [ $n -lt "$RUNS" ]; then
        wait_ms=$((INTERVAL * 1000 - ($(date +%s%N) - start) / 1000000))
        [ $wait_ms -gt 0 ] && sleep "$((wait_ms / 1000)).$(printf %03d $((wait_ms % 1000)))"
    fi
done
cp "$DIR/state.json" "$OUT/state.json" 2> /dev/null
# Separate writes of picture-uri and picture-uri-dark give this Shell error (updater/wallpaper.js).
echo "# shell.log: $(grep -c '_fileWatches is null' "$OUT/shell.log") '_fileWatches is null' errors"
exit $status
