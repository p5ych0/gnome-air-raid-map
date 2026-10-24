# Scenario: install, the failure banner, and uninstall (plan Task 10). Sourced by session.sh.
# The container has no systemd user manager. A stub systemctl first in PATH writes
# "systemctl <arguments>" to $OUT/calls.log; for is-active, a unit is active only if
# the file $STUB/active/<unit> exists. The scenario runs the ExecStart lines
# of the installed units by hand, as systemd runs them for Type=oneshot. In the
# failure unit and during the uninstall, a stub gsettings also writes "gsettings
# <arguments>" to calls.log and then runs the real gsettings. The updater gets its
# data from the local fixture server (fixture.js), not from NEPTUN.
# Steps: 1 set a known wallpaper; 2 install; 3 check the files and the systemctl
# calls; 4 run the service (map-1.png); 5 run the failure unit twice: the second
# run must set no key (banner.png); 6 remove the alert from the fixture data and run
# the service again (map-2.png): the wallpaper must move to a new file name, and the
# screen must show the new picture, not a cached copy of picture-1; 7 install again
# while the timer runs: the saved wallpaper must not change, and the timer stops
# before the files are copied; 8 uninstall (restored.png); 9 install without a
# graphical session: enable the timer, but do not start it.
# Prints "ok - <check>" or "not ok - <check>" for each check, and "#" lines. The
# "#   shell.log:" lines are the new lines of the Shell log after each step.
# Files: map-<n>.png, banner.png, restored.png (screenshots), picture-<n>.png and
# layout-<n>.json (for compare.js), monitors.json, calls.log, *.stdout, *.stderr.
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
# Not first in PATH: install.sh writes the gsettings path into the units.
GSTUB=$XDG_RUNTIME_DIR/stub-gsettings
GSETTINGS=$(command -v gsettings)
KEYS=(picture-uri picture-uri-dark picture-options primary-color)
# The known wallpaper of step 1, as gsettings get prints it. Both pictures are KNOWN_COLOR.
KNOWN=("'file:///tmp/known-light.png'" "'file:///tmp/known-dark.png'" "'zoom'" "'#336699'")
KNOWN_COLOR='#3a6b35'
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

# live_keys <path>: the keys that the updater sets, without primary-color, point to
# the live picture <path>, a file picture-<ms>.png in the runtime folder.
live_keys() {
    local uri dark options
    uri=$(gsettings get "$SCHEMA" picture-uri)
    dark=$(gsettings get "$SCHEMA" picture-uri-dark)
    options=$(gsettings get "$SCHEMA" picture-options)
    echo "#   picture-uri $uri, picture-uri-dark $dark, picture-options $options"
    [[ $1 == "$RUNDIR"/picture-+([0-9]).png ]] &&
        [ "$uri" = "'file://$1'" ] && [ "$dark" = "'file://$1'" ] && [ "$options" = "'spanned'" ]
}

# moved_to_new_file <old> <new>: the wallpaper moved to a new file, and the old file is gone.
moved_to_new_file() {
    echo "#   old $1, new $2"
    [ "$1" != "$2" ] && [ ! -e "$1" ] && [ -f "$2" ]
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

# calls_are <line ...>: the stubs got exactly these calls, in this order.
calls_are() {
    sed 's/^/#   /' "$OUT/calls.log"
    [ "$(cat "$OUT/calls.log")" = "$(printf '%s\n' "$@")" ]
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

# The Fedora image has no cmp. Without sha256sum both sums are empty: not different.
different_files() {
    [ "$(sha256sum < "$1")" != "$(sha256sum < "$2")" ]
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

# sets_are <key ...>: calls.log has a "gsettings set" call for exactly these keys,
# in this order, and no other call except "gsettings get".
sets_are() {
    local keys
    sed 's/^/#   /' "$OUT/calls.log"
    keys=$(grep -v '^gsettings get ' "$OUT/calls.log" | sed "s/^gsettings set $SCHEMA \([^ ]*\) .*/\1/")
    [ "$keys" = "$(printf '%s\n' "$@")" ]
}

# with_gsettings_stub <command ...>: runs the command with the stub gsettings first in PATH.
with_gsettings_stub() {
    PATH="$GSTUB:$PATH" "$@"
}

# run_unit <unit> <name> [<gsettings>]: runs the ExecStart lines of an installed unit
# in order, as systemd does for Type=oneshot, and stops at the first failure. In a
# unit file %% is one %. timeout stops a line as TimeoutStartSec=25s does. The output
# goes to <name>.stdout and <name>.stderr. eval splits the line at spaces and removes
# the quotes, as systemd does; the lines come from the units that install.sh wrote
# from systemd/*.in in this disposable container. With <gsettings>, the lines use
# that program in place of the gsettings path in the unit.
run_unit() {
    local line code=0
    : > "$OUT/$2.stdout"
    : > "$OUT/$2.stderr"
    while IFS= read -r line; do
        line=${line//%%/%}
        echo "#   ExecStart=$line"
        [ -z "${3:-}" ] || line=${line//"$GSETTINGS"/"$3"}
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
# LIVE[n] is the live picture after the run.
LIVE=()
map_step() {
    local n=$1 from
    from=$(shell_log_lines)
    check "run $n of the service exits 0" run_unit "$APP.service" "service-$n"
    LIVE[n]=$(state_value state.picture | tr -d '"')
    check "run $n sets the wallpaper keys to the live picture, spanned" live_keys "${LIVE[n]}"
    cp "${LIVE[n]}" "$OUT/picture-$n.png"
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

mkdir -p "$STUB/active" "$GSTUB"
cat > "$STUB/systemctl" << STUB_END
#!/bin/sh
# The container has no systemd user manager: write the arguments to the log.
# is-active: a unit is active only if the file $STUB/active/<unit> exists.
echo "systemctl \$*" >> '$OUT/calls.log'
if [ "\$2" = is-active ]; then
    for unit; do :; done
    [ -e '$STUB/active/'"\$unit" ] || exit 3
fi
exit 0
STUB_END
printf '%s\n' '#!/bin/sh' '# Write the arguments to the log, then run the real gsettings.' \
    "echo \"gsettings \$*\" >> '$OUT/calls.log'" "exec '$GSETTINGS' \"\$@\"" > "$GSTUB/gsettings"
chmod +x "$STUB/systemctl" "$GSTUB/gsettings"
# A graphical session runs, until step 9.
touch "$STUB/active/graphical-session.target"
: > "$OUT/calls.log"
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
check "step 3: systemctl got daemon-reload, then enable --now $APP.timer" calls_are \
    'systemctl --user show-environment' "systemctl --user is-active --quiet $APP.timer" \
    'systemctl --user daemon-reload' 'systemctl --user is-active --quiet graphical-session.target' \
    "systemctl --user enable --now $APP.timer"

# Step 4: the live map. The fixture data has a red alert on the synthetic square.
map_step 1
check "step 4: map-1.png shows the red alert (#cf4655) in the square on each monitor" \
    indented gjs -m "$HERE/scenarios/square.js" "$OUT/map-1.png" "$OUT/layout-1.json" '#cf4655'

# Step 5: the failure banner. The failure unit runs again every 30 s while the runs
# fail, so its second run must set no key: dconf then writes nothing.
from=$(shell_log_lines)
: > "$OUT/calls.log"
check "step 5: run 1 of the failure unit exits 0" run_unit "$APP-failed.service" failed-1 "$GSTUB/gsettings"
check "step 5: run 1 of the failure unit sets the four keys" sets_are "${KEYS[@]}"
check "step 5: the wallpaper keys point to the banner, centered, #0e1722" \
    keys_are "'$BANNER_URI'" "'$BANNER_URI'" "'centered'" "'#0e1722'"
: > "$OUT/calls.log"
check "step 5: run 2 of the failure unit exits 0" run_unit "$APP-failed.service" failed-2 "$GSTUB/gsettings"
check "step 5: run 2 of the failure unit sets no key" sets_are
check "step 5: the wallpaper keys still point to the banner" \
    keys_are "'$BANNER_URI'" "'$BANNER_URI'" "'centered'" "'#0e1722'"
take banner
check "step 5: banner.png shows the banner centered on #0e1722 on each monitor" \
    indented gjs -m "$HERE/scenarios/centered.js" "$OUT/banner.png" "$OUT/monitors.json" '#0e1722' "$APPDIR/banner.png"
echo "# step 5: $(tail -n +"$((from + 1))" "$OUT/shell.log" | grep -c '_fileWatches is null') '_fileWatches is null' errors in the new lines of shell.log"
shell_log_from "$from"

# Step 6: the live map again, from other data: no alert, so the square has the
# oblast color. A cached copy of picture-1 would still show the red alert.
printf '%s\n' '{"oblasts": [], "raions": []}' | tee "$FIXTURE/alerts-a.json" > "$FIXTURE/alerts-b.json"
map_step 2
# The Shell can have a cached copy of the file of run 1 (docs/decisions/2026-10-23-picture-reload-method.md).
check "step 6: run 2 moved the wallpaper to a new file and deleted the file of run 1" \
    moved_to_new_file "${LIVE[1]}" "${LIVE[2]}"
check "step 6: picture-2.png differs from picture-1.png" different_files "$OUT/picture-1.png" "$OUT/picture-2.png"
check "step 6: map-2.png shows the square without an alert (#223448) on each monitor" \
    indented gjs -m "$HERE/scenarios/square.js" "$OUT/map-2.png" "$OUT/layout-2.json" '#223448'

# Step 7: a second install keeps the wallpaper from before the first install. The
# timer runs now: a run while the files are copied would fail, so the install stops
# the timer before the copy and starts it again at the end.
touch "$STUB/active/$APP.timer"
: > "$OUT/calls.log"
check "step 7: a second install.sh exits 0" install_run install-2
check "step 7: the saved wallpaper did not change" same_file "$OUT/previous-wallpaper" "$STATEDIR/previous-wallpaper"
check "step 7: systemctl got stop $APP.timer before daemon-reload, then enable --now" calls_are \
    'systemctl --user show-environment' "systemctl --user is-active --quiet $APP.timer" \
    "systemctl --user stop $APP.timer" 'systemctl --user daemon-reload' \
    'systemctl --user is-active --quiet graphical-session.target' "systemctl --user enable --now $APP.timer"

# Step 8: uninstall.
: > "$OUT/calls.log"
from=$(shell_log_lines)
check "step 8: install.sh --uninstall exits 0" with_gsettings_stub install_run uninstall --uninstall
check "step 8: the four keys have the known values again" keys_are "${KNOWN[@]}"
check "step 8: the program, cache, state and runtime folders are gone" \
    none_exist "$APPDIR" "$CACHEDIR" "$STATEDIR" "$RUNDIR"
check "step 8: the unit files are gone" none_exist "${UNITS[@]/#/$UNITDIR/}"
# A run that fails during the uninstall queues the failure unit (OnFailure=). Its
# gsettings calls must not come after the restore: stop the timer, then the
# service, then in a later call the failure unit; then restore; then reload.
check "step 8: the units stop in order, then the wallpaper is restored, then daemon-reload" calls_are \
    "systemctl --user disable --now $APP.timer" \
    "systemctl --user stop $APP.service" \
    "systemctl --user stop $APP-failed.service" \
    "systemctl --user reset-failed $APP.service $APP-failed.service" \
    "gsettings set $SCHEMA picture-uri ${KNOWN[0]}" \
    "gsettings set $SCHEMA picture-uri-dark ${KNOWN[1]}" \
    "gsettings set $SCHEMA picture-options ${KNOWN[2]}" \
    "gsettings set $SCHEMA primary-color ${KNOWN[3]}" \
    'systemctl --user daemon-reload'
take restored
check "step 8: restored.png shows the known wallpaper on each monitor" \
    indented gjs -m "$HERE/scenarios/centered.js" "$OUT/restored.png" "$OUT/monitors.json" "$KNOWN_COLOR"
echo "# step 8: $(tail -n +"$((from + 1))" "$OUT/shell.log" | grep -c '_fileWatches is null') '_fileWatches is null' errors in the new lines of shell.log"
shell_log_from "$from"

# Step 9: an install without a graphical session (for example over SSH). Every run
# would fail there, so the install only enables the timer.
rm -f "$STUB/active/"*
: > "$OUT/calls.log"
check "step 9: install.sh without a graphical session exits 0" install_run install-3
check "step 9: systemctl got enable $APP.timer, without --now" calls_are \
    'systemctl --user show-environment' "systemctl --user is-active --quiet $APP.timer" \
    'systemctl --user daemon-reload' 'systemctl --user is-active --quiet graphical-session.target' \
    "systemctl --user enable $APP.timer"
check "step 9: install.sh says that the map starts at the next graphical login" \
    grep -q 'next graphical login' "$OUT/install-3.stdout"

echo "# install: $status (0: every check passed)"
exit $status
