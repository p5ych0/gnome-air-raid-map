# Scenario: the monitor layouts of spec 5.6 (plan Task 9). Sourced by session.sh.
# For each layout: restart the Shell with the virtual monitors of the layout, set
# the scales with monitors.js (ApplyMonitorsConfig, temporary), run the updater once
# against a local fixture server, take a screenshot, and check it with compare.js.
# Layout 5 then runs the updater again with the zoom fallback of spec 5.6 (5z):
# picture-options zoom and a picture of the primary monitor only.
# Layout 5l is layout 5 in the logical layout mode of Mutter (experimental feature
# scale-monitor-framebuffer). GNOME 50 uses this mode by default. GNOME 46 uses the
# physical mode, and the logical mode when the user turns on fractional scaling.
# Prints "layout <n>: monitor-<m> <matches>/25" for each monitor, and "#" lines.
# Files: layout-<n>.png (screenshot), picture-<n>.png, layout-<n>.json (the picture
# layout from the state file of the updater), layout-<n>.stderr (the updater).
# GNOME_TEST_LAYOUTS: the layouts to run (default "1 2 3 4 5 5l").
# GNOME_TEST_BOUNDARIES: a folder in the repository with oblasts.geojson and
# raions.geojson to draw instead of the synthetic square (see fixture.js).
PORT=8765
DIR=$XDG_RUNTIME_DIR/gnome-air-raid-map
FIXTURE=$XDG_RUNTIME_DIR/layouts-fixture
status=0

gjs -m "$HERE/scenarios/fixture.js" "$FIXTURE" ${GNOME_TEST_BOUNDARIES:+"/repo/$GNOME_TEST_BOUNDARIES"} || exit 1
gjs -m /repo/tests/lib/fixture-server.js "$PORT" "$FIXTURE" > "$OUT/fixture-server.log" 2>&1 &
SERVER_PID=$!
# The scenario runs in a subshell: it stops the Shell that it started itself.
trap 'kill "$SERVER_PID" 2> /dev/null; stop_shell' EXIT
for ((i = 0; i < 40; i++)); do
    (exec 5<> "/dev/tcp/127.0.0.1/$PORT") 2> /dev/null && break
    sleep 0.25
done
export AIR_RAID_MAP_API_BASE=http://127.0.0.1:$PORT

# Prints a value of the state file of the updater as JSON: state_value <expression>.
state_value() {
    gjs -c '
        const GLib = imports.gi.GLib;
        const state = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(ARGV[1])[1]));
        print(JSON.stringify(eval(ARGV[0])));' "$1" "$DIR/state.json"
}

# check <name> [--zoom]: one updater run, a screenshot, and compare.js with the
# picture layout layout-<name>.json, or layout-$LAYOUT_JSON.json if it is set.
check() {
    local name=$1 code
    shift
    timeout 25 gjs -m /repo/updater/main.js 2> "$OUT/layout-$name.stderr"
    code=$?
    sed "s/^/# layout $name: stderr: /" "$OUT/layout-$name.stderr"
    [ $code -eq 0 ] || { echo "# layout $name: the updater exited $code"; return 1; }
    cp "$(state_value state.picture | tr -d '"')" "$OUT/picture-$name.png"
    state_value state.layout > "$OUT/layout-$name.json"
    # The layout mode of the display state: Mutter's mode, or "logical" for AIR_RAID_MAP_DISPLAY.
    echo "# layout $name: layout mode $(state_value state.displayState.mode)," \
        "picture-options $(gsettings get org.gnome.desktop.background picture-options)," \
        "picture layout $(cat "$OUT/layout-$name.json")"
    # The Shell shows a new picture in less than 0.4 s (docs/decisions/2026-10-23-picture-reload-method.md).
    sleep 2
    screenshot "$OUT/layout-$name.png" || return 1
    # The Shell can still write the file after the call returns.
    sleep 1
    gjs -m /repo/tests/gnome/compare.js "$@" "$OUT/picture-$name.png" "$OUT/layout-$name.png" "$OUT/layout-${LAYOUT_JSON:-$name}.json" |
        sed -E "s/^(# )?/\1layout $name: /"
    return "${PIPESTATUS[0]}"
}

# layout <n> "<scale ...>" <virtual-monitor ...>
layout() {
    local name=$1 scales=$2 expected
    shift 2
    kill -0 "$SERVER_PID" 2> /dev/null || { echo "# layout $name: the fixture server is not running"; return 1; }
    stop_shell
    # The start state of a new install: no picture, no state file, and the default
    # wallpaper keys, so that the updater sets the keys and the Shell loads the picture.
    rm -rf "$DIR"
    for key in picture-uri picture-uri-dark picture-options; do
        gsettings reset org.gnome.desktop.background "$key"
    done
    start_shell "$@" || return 1
    # shellcheck disable=SC2086 # one argument for each scale
    expected=$(gjs -m "$HERE/scenarios/monitors.js" $scales) || return 1
    wait_shell 10 "JSON.stringify(Main.layoutManager.monitors.map(m => [m.x, m.y, m.width, m.height, m.geometry_scale])
        .sort((a, b) => a[0] - b[0])) === '$expected'" || return 1
    echo "# layout $name: virtual monitors $*, Shell monitors [x, y, width, height, scale] $expected"
    check "$name"
}

# Layout 5 in the logical layout mode. The setting applies when the Shell starts.
logical_layout_5() {
    local code
    gsettings set org.gnome.mutter experimental-features "['scale-monitor-framebuffer']"
    layout 5l "1 2" 1920x1080 3840x2160
    code=$?
    gsettings reset org.gnome.mutter experimental-features
    return $code
}

for n in ${GNOME_TEST_LAYOUTS:-1 2 3 4 5 5l}; do
    case $n in
        1) layout 1 "1" 1920x1080 ;;
        2) layout 2 "2" 3840x2160 ;;
        3) layout 3 "1" 1080x1920 ;;
        4) layout 4 "1 1" 1920x1080 2560x1080 ;;
        # 5z: the primary monitor (1920x1080 logical) at the highest scale (2), so the
        # picture is sharp on the scale-2 monitor. compare.js maps it with the real
        # layout of layout 5.
        5) layout 5 "1 2" 1920x1080 3840x2160 &&
            AIR_RAID_MAP_PICTURE_OPTIONS=zoom AIR_RAID_MAP_DISPLAY=3840x2160@2 LAYOUT_JSON=5 check 5z --zoom ;;
        5l) logical_layout_5 ;;
        *) echo "# unknown layout: $n"; false ;;
    esac || status=1
done
exit $status
