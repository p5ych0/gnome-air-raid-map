# Scenario: install, the failure banner, and uninstall (plan Task 10). Sourced by session.sh.
# The container has no systemd user manager. A stub systemctl first in PATH writes
# its arguments to $OUT/systemctl.log, and the scenario runs the ExecStart lines of
# the installed units by hand, as systemd runs them for Type=oneshot. The updater
# gets its data from the local fixture server (fixture.js), not from NEPTUN.
# Steps: 1 set a known wallpaper; 2 install; 3 check the files and the systemctl
# calls; 4 run the service (map-1.png); 5 run the failure unit (banner.png); 6 run
# the service again (map-2.png); 7 install again: the saved wallpaper must not
# change; 8 uninstall (restored.png).
# Prints "ok - <check>" or "not ok - <check>" for each check, and "#" lines. The
# "#   shell.log:" lines are the new lines of the Shell log after each step.
# Files: map-<n>.png, banner.png, restored.png (screenshots), picture-<n>.png and
# layout-<n>.json (for compare.js), monitors.json, systemctl.log, *.stdout, *.stderr.
PORT=8765
SCHEMA=org.gnome.desktop.background
APP=gnome-air-raid-map
APPDIR=${XDG_DATA_HOME:-$HOME/.local/share}/$APP
UNITDIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
STATEDIR=${XDG_STATE_HOME:-$HOME/.local/state}/$APP
CACHEDIR=${XDG_CACHE_HOME:-$HOME/.cache}/$APP
RUNDIR=$XDG_RUNTIME_DIR/$APP
UNITS=("$APP.service" "$APP.timer" "$APP-failed.service")
FIXTURE=$XDG_RUNTIME_DIR/install-fixture
STUB=$XDG_RUNTIME_DIR/stub-bin
KEYS=(picture-uri picture-uri-dark picture-options primary-color)
# The known wallpaper of step 1, as gsettings get prints it. Both pictures are KNOWN_COLOR.
KNOWN=("'file:///tmp/known-light.png'" "'file:///tmp/known-dark.png'" "'zoom'" "'#336699'")
KNOWN_COLOR='#3a6b35'
LIVE_URI="file://$RUNDIR/picture.png"
BANNER_URI="file://$APPDIR/banner.png"
status=0

# check <description> <command ...>: runs the command and prints ok or not ok.
check() {
    local name=$1
    shift
    if "$@"; then
        echo "ok - $name"
    else
        echo "not ok - $name"
        status=1
    fi
}

# Prints the output of a command as "#   " lines and returns the status of the command.
indented() {
    "$@" 2>&1 | sed 's/^/#   /'
    return "${PIPESTATUS[0]}"
}

# shell_log_from <line>: prints the lines of the Shell log after line <line>.
shell_log_from() {
    tail -n +"$(($1 + 1))" "$OUT/shell.log" | head -n 20 | sed 's/^/#   shell.log: /'
}

shell_log_lines() {
    wc -l < "$OUT/shell.log"
}

# keys_are <value ...>: the KEYS have these values, as gsettings get prints them.
keys_are() {
    local i value result=0
    for i in "${!KEYS[@]}"; do
        value=$(gsettings get "$SCHEMA" "${KEYS[i]}")
        echo "#   ${KEYS[i]} $value"
        [ "$value" = "${@:i+1:1}" ] || result=1
    done
    return $result
}

# The keys that the updater sets, without primary-color.
live_keys() {
    local uri dark options
    uri=$(gsettings get "$SCHEMA" picture-uri)
    dark=$(gsettings get "$SCHEMA" picture-uri-dark)
    options=$(gsettings get "$SCHEMA" picture-options)
    echo "#   picture-uri $uri, picture-uri-dark $dark, picture-options $options"
    [ "$uri" = "'$LIVE_URI'" ] && [ "$dark" = "'$LIVE_URI'" ] && [ "$options" = "'spanned'" ]
}

# The saved wallpaper file has the known values.
saved_known() {
    local i expected=''
    for i in "${!KEYS[@]}"; do
        expected+=$(printf '%s\t%s' "${KEYS[i]}" "${KNOWN[i]}")$'\n'
    done
    sed 's/^/#   previous-wallpaper: /' "$STATEDIR/previous-wallpaper"
    [ "$(cat "$STATEDIR/previous-wallpaper")"$'\n' = "$expected" ]
}

# systemctl_log_is <line ...>: the stub got exactly these calls.
systemctl_log_is() {
    sed 's/^/#   systemctl /' "$OUT/systemctl.log"
    [ "$(cat "$OUT/systemctl.log")" = "$(printf '%s\n' "$@")" ]
}

all_exist() {
    local path result=0
    for path; do
        [ -e "$path" ] || { echo "#   missing: $path"; result=1; }
    done
    return $result
}

none_exist() {
    local path result=0
    for path; do
        [ ! -e "$path" ] || { echo "#   still there: $path"; result=1; }
    done
    return $result
}

no_placeholders() {
    ! grep -n '@[A-Z_]*@' "${UNITS[@]/#/$UNITDIR/}"
}

# png_size <file> <width> <height>
png_size() {
    local size
    size=$(gjs -c '
        const [format, width, height] = imports.gi.GdkPixbuf.Pixbuf.get_file_info(ARGV[0]);
        print(format ? `${format.get_name()} ${width}x${height}` : "none");' "$1")
    echo "#   $1: $size"
    [ "$size" = "png ${2}x$3" ]
}

same_file() {
    [ "$(cat "$1")" = "$(cat "$2")" ]
}

# install_run <name> [--uninstall]: runs /repo/install.sh; the output goes to <name>.stdout and .stderr.
install_run() {
    local name=$1 code
    shift
    /repo/install.sh "$@" > "$OUT/$name.stdout" 2> "$OUT/$name.stderr"
    code=$?
    sed "s/^/#   $name: /" "$OUT/$name.stdout" "$OUT/$name.stderr"
    return $code
}

# run_unit <unit> <name>: runs the ExecStart lines of an installed unit in order, as
# systemd does for Type=oneshot, and stops at the first failure. In a unit file %%
# is one %. timeout stops a line as TimeoutStartSec=25s does. The output goes to
# <name>.stdout and <name>.stderr. eval splits the line at spaces and removes the
# quotes, as systemd does; the lines come from the units that install.sh wrote from
# systemd/*.in in this disposable container.
run_unit() {
    local line code=0
    : > "$OUT/$2.stdout"
    : > "$OUT/$2.stderr"
    while IFS= read -r line; do
        line=${line//%%/%}
        echo "#   ExecStart=$line"
        eval "timeout 25 $line" < /dev/null >> "$OUT/$2.stdout" 2>> "$OUT/$2.stderr" || {
            code=$?
            break
        }
    done < <(sed -n 's/^ExecStart=//p' "$UNITDIR/$1")
    sed "s/^/#   $2: /" "$OUT/$2.stdout" "$OUT/$2.stderr"
    return $code
}

# Prints a value of the state file of the updater as JSON: state_value <expression>.
state_value() {
    gjs -c '
        const GLib = imports.gi.GLib;
        const state = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(ARGV[1])[1]));
        print(JSON.stringify(eval(ARGV[0])));' "$1" "$RUNDIR/state.json"
}

# take <name>: waits until the Shell shows the new wallpaper, then takes <name>.png.
# The Shell shows a new picture in less than 0.4 s (docs/decisions/2026-10-23-picture-reload-method.md).
take() {
    sleep 2
    screenshot "$OUT/$1.png" || return 1
    # The Shell can still write the file after the call returns.
    sleep 1
}

# map_step <n>: runs the service, takes map-<n>.png, and checks it with compare.js.
map_step() {
    local n=$1 from
    from=$(shell_log_lines)
    check "run $n of the service exits 0" run_unit "$APP.service" "service-$n"
    check "run $n sets the wallpaper keys to the live picture, spanned" live_keys
    cp "$RUNDIR/picture.png" "$OUT/picture-$n.png"
    state_value state.layout > "$OUT/layout-$n.json"
    take "map-$n"
    check "map-$n.png shows the live picture on each monitor" \
        indented gjs -m /repo/tests/gnome/compare.js "$OUT/picture-$n.png" "$OUT/map-$n.png" "$OUT/layout-$n.json"
    shell_log_from "$from"
}

# Step 0: the fixture server, the stub systemctl, and the known pictures.
gjs -m "$HERE/scenarios/fixture.js" "$FIXTURE" || exit 1
gjs -m /repo/tests/lib/fixture-server.js "$PORT" "$FIXTURE" > "$OUT/fixture-server.log" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2> /dev/null' EXIT
for ((i = 0; i < 40; i++)); do
    (exec 5<> "/dev/tcp/127.0.0.1/$PORT") 2> /dev/null && break
    sleep 0.25
done
export AIR_RAID_MAP_API_BASE=http://127.0.0.1:$PORT

mkdir -p "$STUB"
printf '%s\n' '#!/bin/sh' '# The container has no systemd user manager: write the arguments to the log.' \
    "echo \"\$*\" >> '$OUT/systemctl.log'" > "$STUB/systemctl"
chmod +x "$STUB/systemctl"
: > "$OUT/systemctl.log"
export PATH="$STUB:$PATH"

for picture in /tmp/known-light.png /tmp/known-dark.png; do
    gjs -c '
        const Cairo = imports.cairo;
        const surface = new Cairo.ImageSurface(Cairo.Format.RGB24, 64, 64);
        const cr = new Cairo.Context(surface);
        cr.setSourceRGB(0x3a / 255, 0x6b / 255, 0x35 / 255);
        cr.paint();
        cr.$dispose();
        surface.writeToPNG(ARGV[0]);
        surface.finish();' "$picture" || exit 1
done

shell_eval 'Main.layoutManager.monitors.map(m => [m.x, m.y, m.width, m.height, m.geometry_scale])' > "$OUT/monitors.json"
echo "# Shell monitors [x, y, width, height, scale]: $(cat "$OUT/monitors.json")"

# Step 1: a known wallpaper, in one change (see set_wallpaper in session.sh).
gjs -c '
    const Gio = imports.gi.Gio;
    const settings = new Gio.Settings({schema_id: "org.gnome.desktop.background"});
    settings.delay();
    settings.set_string("picture-uri", "file:///tmp/known-light.png");
    settings.set_string("picture-uri-dark", "file:///tmp/known-dark.png");
    settings.set_string("picture-options", "zoom");
    settings.set_string("primary-color", "#336699");
    settings.apply();
    Gio.Settings.sync();'
check "step 1: the known wallpaper is set" keys_are "${KNOWN[@]}"

# Steps 2 and 3: install, and check the result.
check "step 2: install.sh exits 0" install_run install-1
check "step 3: the three units exist" all_exist "${UNITS[@]/#/$UNITDIR/}"
check "step 3: no @...@ value is left in the units" no_placeholders
sed 's/^/#   /' "$UNITDIR/$APP.service" "$UNITDIR/$APP-failed.service" | grep -E '^#   (ExecStart|OnFailure|SuccessExitStatus)='
check "step 3: a stop of the service (SIGTERM) is a clean exit, not a failure" \
    grep -qx 'SuccessExitStatus=SIGTERM' "$UNITDIR/$APP.service"
check "step 3: the banner is a 1200x360 PNG" png_size "$APPDIR/banner.png" 1200 360
check "step 3: the saved wallpaper has the known values" saved_known
cp "$STATEDIR/previous-wallpaper" "$OUT/previous-wallpaper"
check "step 3: systemctl got daemon-reload, then enable --now $APP.timer" systemctl_log_is \
    '--user show-environment' '--user daemon-reload' "--user enable --now $APP.timer"

# Step 4: the live map.
map_step 1

# Step 5: the failure banner.
from=$(shell_log_lines)
check "step 5: the failure unit exits 0" run_unit "$APP-failed.service" failed
check "step 5: the wallpaper keys point to the banner, centered, #0e1722" \
    keys_are "'$BANNER_URI'" "'$BANNER_URI'" "'centered'" "'#0e1722'"
take banner
check "step 5: banner.png shows the banner centered on #0e1722 on each monitor" \
    indented gjs -m "$HERE/scenarios/centered.js" "$OUT/banner.png" "$OUT/monitors.json" '#0e1722' "$APPDIR/banner.png"
echo "# step 5: $(tail -n +"$((from + 1))" "$OUT/shell.log" | grep -c '_fileWatches is null') '_fileWatches is null' errors in the new lines of shell.log"
shell_log_from "$from"

# Step 6: the live map again.
map_step 2

# Step 7: a second install keeps the wallpaper from before the first install.
check "step 7: a second install.sh exits 0" install_run install-2
check "step 7: the saved wallpaper did not change" same_file "$OUT/previous-wallpaper" "$STATEDIR/previous-wallpaper"

# Step 8: uninstall.
: > "$OUT/systemctl.log"
from=$(shell_log_lines)
check "step 8: install.sh --uninstall exits 0" install_run uninstall --uninstall
check "step 8: the four keys have the known values again" keys_are "${KNOWN[@]}"
check "step 8: the program, cache, state and runtime folders are gone" \
    none_exist "$APPDIR" "$CACHEDIR" "$STATEDIR" "$RUNDIR"
check "step 8: the unit files are gone" none_exist "${UNITS[@]/#/$UNITDIR/}"
check "step 8: systemctl got disable --now $APP.timer first and daemon-reload last" systemctl_log_is \
    "--user disable --now $APP.timer" "--user stop $APP.service $APP-failed.service" '--user daemon-reload'
take restored
check "step 8: restored.png shows the known wallpaper on each monitor" \
    indented gjs -m "$HERE/scenarios/centered.js" "$OUT/restored.png" "$OUT/monitors.json" "$KNOWN_COLOR"
echo "# step 8: $(tail -n +"$((from + 1))" "$OUT/shell.log" | grep -c '_fileWatches is null') '_fileWatches is null' errors in the new lines of shell.log"
shell_log_from "$from"

echo "# install: $status (0: every check passed)"
exit $status
