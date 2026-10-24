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
# graphical session: enable the timer, but do not start it; 10 lose the saved
# wallpaper while the map shows, install again: no key is saved, and the uninstall
# resets all four keys; 11 install again while the timer runs, and make the install
# fail after it stopped the timer: the timer starts again and the banner shows;
# 12 lose the saved wallpaper while the banner shows: the uninstall resets the four
# keys, and does not leave a deleted picture; 13 lose the saved wallpaper while
# the wallpaper is not a picture of the program: the uninstall leaves the keys;
# 14 make the copy of a second install fail: the old program, its failure script
# and its live picture stay, the timer starts again, and no staging folder is left;
# 15 make the swap fail between its two renames: the old program is moved back, the
# timer starts again, no wallpaper key points to a missing file, and the next run
# works; 16 stop the install with SIGTERM after the first rename of the swap: the
# result is the same as in step 15, and the install exits with a non-zero status;
# 17 send SIGTERM before the first rename of the swap ends: the install waits for the
# rename, and the old program is moved back; 18 stop the install with SIGHUP after the
# first rename, with its stderr on /dev/full (a closed terminal): the recovery still
# moves the old program back and starts the timer; 19 leave the old program in
# $APPDIR.old and a complete $APPDIR.new with $APPDIR absent, as a SIGKILL between the
# two renames does, and make the copy of the next install fail: the old program is
# moved back first, and the failure script does not run.
# Step 8 also checks that the uninstall deletes the staging folders.
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

# saved_keys_are <key ...>: the saved wallpaper file has lines for exactly these keys.
saved_keys_are() {
    sed 's/^/#   previous-wallpaper: /' "$STATEDIR/previous-wallpaper"
    [ "$(cut -f 1 "$STATEDIR/previous-wallpaper")" = "$(printf '%s\n' "$@")" ]
}

saved_is_empty() {
    [ -e "$STATEDIR/previous-wallpaper" ] && [ ! -s "$STATEDIR/previous-wallpaper" ]
}

# call_order <line ...>: calls.log has these lines, in this order (other lines can be between them).
call_order() {
    local line n=0 found
    for line; do
        found=$(tail -n +"$((n + 1))" "$OUT/calls.log" | grep -nxF -m 1 -- "$line" | cut -d: -f1)
        [ -n "$found" ] || { echo "#   missing after line $n: $line"; return 1; }
        n=$((n + found))
    done
}

not() {
    ! "$@"
}

# no_user_value <key ...>: the keys have no user value (as after gsettings reset).
no_user_value() {
    indented gjs -c '
        const settings = new imports.gi.Gio.Settings({schema_id: ARGV[0]});
        const set = ARGV.slice(1).filter(key => settings.get_user_value(key) !== null);
        print(set.length ? `user values: ${set.join(" ")}` : "no user values");
        imports.system.exit(set.length ? 1 : 0);' "$SCHEMA" "$@"
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
sed 's/^/#   /' "$UNITDIR/$APP.service" "$UNITDIR/$APP-failed.service" | grep -E '^#   (ExecStart|OnFailure|SuccessExitStatus|Memory[A-Za-z]*)='
check "step 3: a stop of the service (SIGTERM) is a clean exit, not a failure" \
    grep -qx 'SuccessExitStatus=SIGTERM' "$UNITDIR/$APP.service"
check "step 3: the service may not use swap, so MemoryMax=300M is a hard limit" \
    grep -qx 'MemorySwapMax=0' "$UNITDIR/$APP.service"
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
check "step 7: systemctl got stop of the timer and the service before daemon-reload, then enable --now" calls_are \
    'systemctl --user show-environment' "systemctl --user is-active --quiet $APP.timer" \
    "systemctl --user stop $APP.timer" "systemctl --user stop $APP.service" 'systemctl --user daemon-reload' \
    'systemctl --user is-active --quiet graphical-session.target' "systemctl --user enable --now $APP.timer"

# Step 8: uninstall. Staging folders that an install left (after a kill or a power
# loss) are deleted too.
mkdir -p "$APPDIR.new" "$APPDIR.old"
: > "$OUT/calls.log"
from=$(shell_log_lines)
check "step 8: install.sh --uninstall exits 0" with_gsettings_stub install_run uninstall --uninstall
check "step 8: the four keys have the known values again" keys_are "${KNOWN[@]}"
check "step 8: the program, cache, state and runtime folders are gone" \
    none_exist "$APPDIR" "$CACHEDIR" "$STATEDIR" "$RUNDIR"
check "step 8: the staging folders $APP.new and $APP.old are gone" none_exist "$APPDIR.new" "$APPDIR.old"
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

# Step 10: the saved wallpaper is lost while the map shows (picture-uri) and the
# banner shows (picture-uri-dark). A new install must not save these pictures, nor
# picture-options and primary-color, which are the values of the program: it saves
# no key, and the uninstall resets all four.
check "step 10: run 3 of the service exits 0" run_unit "$APP.service" service-3
gsettings set "$SCHEMA" picture-uri-dark "'$BANNER_URI'"
rm -f "$STATEDIR/previous-wallpaper"
check "step 10: install.sh exits 0" install_run install-4
check "step 10: install.sh warns that it does not save picture-uri" \
    grep -q "warning: picture-uri is 'file://$RUNDIR/" "$OUT/install-4.stderr"
check "step 10: install.sh warns that it does not save picture-uri-dark" \
    grep -q "warning: picture-uri-dark is '$BANNER_URI'" "$OUT/install-4.stderr"
check "step 10: the saved wallpaper file has no key" saved_is_empty
: > "$OUT/calls.log"
check "step 10: install.sh --uninstall exits 0" with_gsettings_stub install_run uninstall-2 --uninstall
check "step 10: the uninstall resets the four keys" calls_are \
    "systemctl --user disable --now $APP.timer" \
    "systemctl --user stop $APP.service" \
    "systemctl --user stop $APP-failed.service" \
    "systemctl --user reset-failed $APP.service $APP-failed.service" \
    "gsettings reset $SCHEMA picture-uri" \
    "gsettings reset $SCHEMA picture-uri-dark" \
    "gsettings reset $SCHEMA picture-options" \
    "gsettings reset $SCHEMA primary-color" \
    'systemctl --user daemon-reload'
check "step 10: the four keys have the GNOME default values" no_user_value "${KEYS[@]}"
check "step 10: the program, cache, state and runtime folders are gone" \
    none_exist "$APPDIR" "$CACHEDIR" "$STATEDIR" "$RUNDIR"

# Step 11: a second install fails after it stopped the timer. The failure is a
# folder in the place of the file of the timer unit: the redirection of sed fails
# after the new program was swapped in. The EXIT trap of install.sh must start the timer
# again and show the banner (the stub gsettings is first in PATH, so that install.sh
# uses it for the failure script).
check "step 11: a clean install.sh exits 0" install_run install-5
touch "$STUB/active/$APP.timer"
rm "$UNITDIR/$APP.timer"
mkdir "$UNITDIR/$APP.timer"
: > "$OUT/calls.log"
check "step 11: install.sh fails" not with_gsettings_stub install_run install-6
sed 's/^/#   /' "$OUT/calls.log"
check "step 11: systemctl got stop $APP.timer, then stop $APP.service, then start $APP.timer" \
    call_order "systemctl --user stop $APP.timer" "systemctl --user stop $APP.service" \
    "systemctl --user start $APP.timer"
check "step 11: the failure script set the banner keys" \
    grep -qx "gsettings set $SCHEMA picture-uri '$BANNER_URI'" "$OUT/calls.log"
check "step 11: install.sh says that it starts the timer again" \
    grep -q "starting $APP.timer again" "$OUT/install-6.stderr"
rmdir "$UNITDIR/$APP.timer"

# Step 12: the saved wallpaper is lost while the banner shows (step 11). The uninstall
# resets the four keys: the program deletes the banner, and a key must not point to it.
rm -f "$STATEDIR/previous-wallpaper"
: > "$OUT/calls.log"
check "step 12: install.sh --uninstall exits 0" with_gsettings_stub install_run uninstall-3 --uninstall
check "step 12: the uninstall resets the four keys" calls_are \
    "systemctl --user disable --now $APP.timer" \
    "systemctl --user stop $APP.service" \
    "systemctl --user stop $APP-failed.service" \
    "systemctl --user reset-failed $APP.service $APP-failed.service" \
    "gsettings get $SCHEMA picture-uri" \
    "gsettings reset $SCHEMA picture-uri" \
    "gsettings get $SCHEMA picture-uri-dark" \
    "gsettings reset $SCHEMA picture-uri-dark" \
    "gsettings reset $SCHEMA picture-options" \
    "gsettings reset $SCHEMA primary-color" \
    'systemctl --user daemon-reload'
check "step 12: the four keys have the GNOME default values" no_user_value "${KEYS[@]}"
check "step 12: the program, cache, state and runtime folders are gone" \
    none_exist "$APPDIR" "$CACHEDIR" "$STATEDIR" "$RUNDIR"

# Step 13: the saved wallpaper is lost, and the wallpaper is not a picture of the
# program: the uninstall leaves the keys as they are.
gsettings set "$SCHEMA" picture-uri "${KNOWN[0]}"
gsettings set "$SCHEMA" picture-uri-dark "${KNOWN[1]}"
gsettings set "$SCHEMA" picture-options "${KNOWN[2]}"
gsettings set "$SCHEMA" primary-color "${KNOWN[3]}"
check "step 13: install.sh exits 0" install_run install-7
rm -f "$STATEDIR/previous-wallpaper"
: > "$OUT/calls.log"
check "step 13: install.sh --uninstall exits 0" with_gsettings_stub install_run uninstall-4 --uninstall
check "step 13: the uninstall only reads the two picture keys" calls_are \
    "systemctl --user disable --now $APP.timer" \
    "systemctl --user stop $APP.service" \
    "systemctl --user stop $APP-failed.service" \
    "systemctl --user reset-failed $APP.service $APP-failed.service" \
    "gsettings get $SCHEMA picture-uri" \
    "gsettings get $SCHEMA picture-uri-dark" \
    'systemctl --user daemon-reload'
check "step 13: the four keys have the known values" keys_are "${KNOWN[@]}"

# Step 14: the copy of the program fails (as on a full disk). The install builds the
# new program next to the old one, so the old program and its failure script must stay
# complete: the timer starts again, and a run of the service still shows the live map.
# A stub cp fails the recursive copy and runs the real cp for all other calls.
FAILCP=$XDG_RUNTIME_DIR/stub-failing-cp
mkdir -p "$FAILCP"
printf '%s\n' '#!/bin/sh' '# Fail the copy of the folders: no space left.' \
    'if [ "$1" = -R ]; then echo "cp: error writing: No space left on device" >&2; exit 1; fi' \
    "exec '$(command -v cp)' \"\$@\"" > "$FAILCP/cp"
chmod +x "$FAILCP/cp"

# with_failing_cp <command ...>: runs the command with the stub cp first in PATH.
with_failing_cp() {
    PATH="$FAILCP:$PATH" "$@"
}

check "step 14: a clean install.sh exits 0" install_run install-8
touch "$STUB/active/$APP.timer"
: > "$OUT/calls.log"
check "step 14: install.sh fails when the copy fails" not with_failing_cp install_run install-9
sed 's/^/#   /' "$OUT/calls.log"
check "step 14: the old program and its failure script are still there" \
    all_exist "$APPDIR/updater/main.js" "$APPDIR/updater/failed.sh" "$APPDIR/core" "$APPDIR/banner.png" "$APPDIR/LICENSE"
check "step 14: systemctl got stop $APP.timer, then start $APP.timer" \
    call_order "systemctl --user stop $APP.timer" "systemctl --user start $APP.timer"
check "step 14: the failed install left no staging folder" none_exist "$APPDIR.new" "$APPDIR.old"
check "step 14: the service still runs and sets the live picture" run_unit "$APP.service" service-4
check "step 14: the wallpaper keys point to the new live picture" live_keys "$(state_value state.picture | tr -d '"')"
# An earlier install that stopped left both folders: the next install deletes them.
mkdir -p "$APPDIR.new/updater" "$APPDIR.old/updater"
check "step 14: a clean install.sh exits 0 after the failed one" install_run install-10
check "step 14: no staging folder is left after the install" none_exist "$APPDIR.new" "$APPDIR.old"
check "step 14: the installed program is complete" \
    all_exist "$APPDIR/updater/main.js" "$APPDIR/updater/failed.sh" "$APPDIR/core" "$APPDIR/banner.png" "$APPDIR/LICENSE"

# Step 15: the swap fails between its two renames, as on a full btrfs (rename can fail
# with ENOSPC) or after a signal: the old program is already moved to $APPDIR.old and
# the new program is complete. The trap must move the old program back. A stub mv
# fails when its source is the staging folder and runs the real mv for all other calls.
FAILMV=$XDG_RUNTIME_DIR/stub-failing-mv
mkdir -p "$FAILMV"
printf '%s\n' '#!/bin/sh' '# Fail the rename of the new program into place.' \
    'for argument; do' \
    "    if [ \"\$argument\" = '$APPDIR.new' ]; then echo \"mv: cannot move: No space left on device\" >&2; exit 1; fi" \
    'done' \
    "exec '$(command -v mv)' \"\$@\"" > "$FAILMV/mv"
chmod +x "$FAILMV/mv"

# with_failing_mv <command ...>: runs the command with the stub mv first in PATH.
with_failing_mv() {
    PATH="$FAILMV:$PATH" "$@"
}

# keys_point_to_files: the files of picture-uri and picture-uri-dark exist.
keys_point_to_files() {
    local key value result=0
    for key in picture-uri picture-uri-dark; do
        value=$(gsettings get "$SCHEMA" "$key")
        value=${value#\'file://}
        value=${value%\'}
        echo "#   $key file: $value"
        [ -f "$value" ] || result=1
    done
    return $result
}

check "step 15: a clean install.sh exits 0" install_run install-11
touch "$STUB/active/$APP.timer"
: > "$OUT/calls.log"
check "step 15: install.sh fails when the swap fails" not with_gsettings_stub with_failing_mv install_run install-12
sed 's/^/#   /' "$OUT/calls.log"
check "step 15: the old program is moved back and is complete" \
    all_exist "$APPDIR/updater/main.js" "$APPDIR/updater/failed.sh" "$APPDIR/core" "$APPDIR/banner.png" "$APPDIR/LICENSE"
check "step 15: the failed install left no staging folder" none_exist "$APPDIR.new" "$APPDIR.old"
check "step 15: systemctl got stop $APP.timer, then start $APP.timer" \
    call_order "systemctl --user stop $APP.timer" "systemctl --user start $APP.timer"
check "step 15: no wallpaper key points to a missing file" keys_point_to_files
check "step 15: the old program is intact, so the failure script did not run" \
    not grep -q '^gsettings set ' "$OUT/calls.log"
check "step 15: the service still runs and sets the live picture" run_unit "$APP.service" service-5
check "step 15: the wallpaper keys point to the new live picture" live_keys "$(state_value state.picture | tr -d '"')"

# Step 16: a termination signal (SIGTERM or SIGHUP) stops the install after the first
# rename of the swap. Bash runs the EXIT trap with status 0 then, so the trap must not
# depend on the status. A stub mv does the real rename, and then, for the rename of
# the old program to $APPDIR.old only, sends SIGTERM to its parent: the install. It
# sends the signal once: the trap moves the old program back with the same rename.
TERMMV=$XDG_RUNTIME_DIR/stub-term-mv
mkdir -p "$TERMMV"
rm -f "$TERMMV/sent"
printf '%s\n' '#!/bin/sh' '# Do the rename. After the rename of the old program, stop the install.' \
    "'$(command -v mv)' \"\$@\" || exit 1" \
    'for argument; do' \
    "    if [ \"\$argument\" = '$APPDIR.old' ] && [ ! -e '$TERMMV/sent' ]; then" \
    "        : > '$TERMMV/sent'; kill -TERM \"\$PPID\"" \
    '    fi' \
    'done' > "$TERMMV/mv"
chmod +x "$TERMMV/mv"

# with_terminating_mv <command ...>: runs the command with the stub mv first in PATH.
with_terminating_mv() {
    PATH="$TERMMV:$PATH" "$@"
}

check "step 16: a clean install.sh exits 0" install_run install-13
touch "$STUB/active/$APP.timer"
: > "$OUT/calls.log"
check "step 16: install.sh exits with a non-zero status when SIGTERM stops it" \
    not with_gsettings_stub with_terminating_mv install_run install-14
sed 's/^/#   /' "$OUT/calls.log"
check "step 16: the old program is moved back and is complete" \
    all_exist "$APPDIR/updater/main.js" "$APPDIR/updater/failed.sh" "$APPDIR/core" "$APPDIR/banner.png" "$APPDIR/LICENSE"
check "step 16: the failed install left no staging folder" none_exist "$APPDIR.new" "$APPDIR.old"
check "step 16: systemctl got stop $APP.timer, then start $APP.timer" \
    call_order "systemctl --user stop $APP.timer" "systemctl --user start $APP.timer"
check "step 16: no wallpaper key points to a missing file" keys_point_to_files
check "step 16: the old program is intact, so the failure script did not run" \
    not grep -q '^gsettings set ' "$OUT/calls.log"
check "step 16: the service still runs and sets the live picture" run_unit "$APP.service" service-6
check "step 16: the wallpaper keys point to the new live picture" live_keys "$(state_value state.picture | tr -d '"')"

# make_signal_mv <folder> <signal> <before|after>: writes a stub mv into the folder. For
# the rename that has $APPDIR.old as an argument, and once only (the recovery uses the
# same rename), it sends the signal to its parent, the install. "before": it sends the
# signal, waits 1 s, and then does the rename, so the install gets the signal while mv
# runs. "after": it does the rename, and then sends the signal.
make_signal_mv() {
    local folder=$1 signal=$2 when=$3 send
    send="[ ! -e '$folder/sent' ] && : > '$folder/sent' && kill -$signal \"\$PPID\""
    mkdir -p "$folder"
    rm -f "$folder/sent"
    {
        echo '#!/bin/sh'
        if [ "$when" = before ]; then
            echo 'for argument; do'
            echo "    if [ \"\$argument\" = '$APPDIR.old' ]; then $send && sleep 1; fi"
            echo 'done'
            echo "exec '$(command -v mv)' \"\$@\""
        else
            echo "'$(command -v mv)' \"\$@\" || exit 1"
            echo 'for argument; do'
            echo "    if [ \"\$argument\" = '$APPDIR.old' ]; then $send; fi"
            echo 'done'
        fi
    } > "$folder/mv"
    chmod +x "$folder/mv"
}

# with_stub_mv <folder> <command ...>: runs the command with the stub mv of the folder first in PATH.
with_stub_mv() {
    local folder=$1
    shift
    PATH="$folder:$PATH" "$@"
}

# Step 17: SIGTERM comes while mv does the first rename of the swap. Bash must wait for
# mv, and only then run the recovery: if it ran the recovery at once, the old program
# would not be in $APPDIR.old yet, and nothing would move it back.
SIGMV17=$XDG_RUNTIME_DIR/stub-term-before-mv
make_signal_mv "$SIGMV17" TERM before

check "step 17: a clean install.sh exits 0" install_run install-15
touch "$STUB/active/$APP.timer"
: > "$OUT/calls.log"
check "step 17: install.sh exits with a non-zero status when SIGTERM comes during the rename" \
    not with_gsettings_stub with_stub_mv "$SIGMV17" install_run install-16
sed 's/^/#   /' "$OUT/calls.log"
# If the install did not wait for mv, mv is still running here: wait until it ends.
sleep 2
check "step 17: the old program is moved back and is complete" \
    all_exist "$APPDIR/updater/main.js" "$APPDIR/updater/failed.sh" "$APPDIR/core" "$APPDIR/banner.png" "$APPDIR/LICENSE"
check "step 17: the failed install left no staging folder" none_exist "$APPDIR.new" "$APPDIR.old"
check "step 17: systemctl got stop $APP.timer, then start $APP.timer" \
    call_order "systemctl --user stop $APP.timer" "systemctl --user start $APP.timer"
check "step 17: no wallpaper key points to a missing file" keys_point_to_files
check "step 17: the old program is intact, so the failure script did not run" \
    not grep -q '^gsettings set ' "$OUT/calls.log"
check "step 17: the service still runs and sets the live picture" run_unit "$APP.service" service-7
check "step 17: the wallpaper keys point to the new live picture" live_keys "$(state_value state.picture | tr -d '"')"

# Step 18: SIGHUP comes after the first rename of the swap, and the terminal is closed:
# a write to stderr fails. The recovery must go on after a warning that it cannot write.
# /dev/full makes every write fail. install_run_closed is install_run with this stderr.
SIGMV18=$XDG_RUNTIME_DIR/stub-hup-after-mv
make_signal_mv "$SIGMV18" HUP after

# install_run_closed <name>: runs /repo/install.sh with stderr on /dev/full.
install_run_closed() {
    local name=$1 code
    /repo/install.sh > "$OUT/$name.stdout" 2> /dev/full
    code=$?
    sed "s/^/#   $name: /" "$OUT/$name.stdout"
    return $code
}

check "step 18: a clean install.sh exits 0" install_run install-17
touch "$STUB/active/$APP.timer"
: > "$OUT/calls.log"
check "step 18: install.sh exits with a non-zero status when SIGHUP stops it" \
    not with_gsettings_stub with_stub_mv "$SIGMV18" install_run_closed install-18
sed 's/^/#   /' "$OUT/calls.log"
check "step 18: the old program is moved back and is complete" \
    all_exist "$APPDIR/updater/main.js" "$APPDIR/updater/failed.sh" "$APPDIR/core" "$APPDIR/banner.png" "$APPDIR/LICENSE"
check "step 18: the failed install left no staging folder" none_exist "$APPDIR.new" "$APPDIR.old"
check "step 18: systemctl got stop $APP.timer, then start $APP.timer" \
    call_order "systemctl --user stop $APP.timer" "systemctl --user start $APP.timer"
check "step 18: the service still runs and sets the live picture" run_unit "$APP.service" service-8
check "step 18: the wallpaper keys point to the new live picture" live_keys "$(state_value state.picture | tr -d '"')"

# Step 19: a SIGKILL or a power loss between the two renames of the swap runs no trap.
# It leaves $APPDIR absent and the only complete program in $APPDIR.old. The next
# install must move it back before it deletes the staging folders: if the copy then
# fails, the old program is still the one to run. The kill also leaves the complete
# new program in $APPDIR.new.
check "step 19: a clean install.sh exits 0" install_run install-19
mv -T "$APPDIR" "$APPDIR.old"
cp -R "$APPDIR.old" "$APPDIR.new"
touch "$STUB/active/$APP.timer"
: > "$OUT/calls.log"
check "step 19: install.sh fails when the copy fails" \
    not with_gsettings_stub with_failing_cp install_run install-20
sed 's/^/#   /' "$OUT/calls.log"
check "step 19: the old program is moved back and is complete" \
    all_exist "$APPDIR/updater/main.js" "$APPDIR/updater/failed.sh" "$APPDIR/core" "$APPDIR/banner.png" "$APPDIR/LICENSE"
check "step 19: the failed install left no staging folder" none_exist "$APPDIR.new" "$APPDIR.old"
check "step 19: systemctl got stop $APP.timer, then start $APP.timer" \
    call_order "systemctl --user stop $APP.timer" "systemctl --user start $APP.timer"
check "step 19: the old program is intact, so the failure script did not run" \
    not grep -q '^gsettings set ' "$OUT/calls.log"
check "step 19: the service still runs and sets the live picture" run_unit "$APP.service" service-9
check "step 19: the wallpaper keys point to the new live picture" live_keys "$(state_value state.picture | tr -d '"')"

echo "# install: $status (0: every check passed)"
exit $status
