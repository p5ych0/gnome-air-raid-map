# Scenario: the real systemd user units (plan Task 11). Sourced by session-systemd.sh,
# as root, in a container where systemd is PID 1 (tests/gnome/run-systemd.sh). The
# real install.sh runs as the test user with the environment of its user manager.
# The timer of the user manager starts every run; nothing runs the updater by hand.
# The updater gets its data from the local fixture server (fixture.js), through
# AIR_RAID_MAP_API_BASE in the user manager environment (systemctl --user set-environment).
# The live picture is the picture*.png file in the runtime folder that the settings
# point to: after the failure banner, the updater uses a new name (picture-<ms>.png).
# Steps:
#   a  log out; install with graphical-session.target inactive: the timer is enabled
#      but not active, and install.sh says so; no run while logged out. Log in: the
#      timer starts a run at session start and then every ~30 s; 4 runs exit 0; the
#      screen shows the live picture; one picture file. Log out and in again: the
#      timer stops and starts with the session.
#   b  a drop-in breaks the display (AIR_RAID_MAP_DISPLAY=broken), and the saved
#      layout is removed from the state file: the run fails, OnFailure= sets the
#      banner. The next failure runs the failure unit again, and it sets no key (no
#      dconf Change call). Without the drop-in, the next run puts the live picture
#      back under a new file name, and one picture file remains.
#   c  MemoryMax, MemorySwapMax=0, TimeoutStartSec, OnFailure= and SuccessExitStatus of
#      the service, and the kernel limits of a running run. A drop-in with
#      TimeoutStartSec=5s and a server that never answers: systemd stops the run at
#      the timeout (a failure), and OnFailure= sets the banner. The same server with
#      TimeoutStartSec=25s: the 15 s request deadline ends the run first (exit 0).
#      systemctl stop during a run: the result is success, and the failure unit does
#      not run. MemoryMax=20M (information); MemoryMax=4M: oom-kill, and OnFailure=
#      sets the banner. Then the live picture again, and one picture file.
#   f  no .goutputstream-* or *.tmp file in the runtime, cache, state and data folders.
#      Information: a lost state file leaves the old picture file.
#   d  uninstall: the wallpaper from before the install, no file of the program in
#      the home and runtime folders, no unit, no run after the uninstall.
#   e  install again; a run that waits for a server that never answers; the uninstall
#      during that run: the wallpaper from before the install, not the banner, and no
#      run of the failure unit after the uninstall began.
# Prints "ok - <check>" or "not ok - <check>" for each check, and "#" lines.
# Files: a-live.png, b-banner.png, b-live.png, c-banner.png, c-oom-banner.png,
# c-live.png, d-restored.png, e-restored.png (screenshots); <name>-picture.png and
# <name>-layout.json (for compare.js); journal-<step>.txt (journalctl --user
# excerpts); runs.txt (one line for each run that the scenario waited for);
# dconf-changes.txt (the dconf Change calls of step b); install*.*, uninstall*.*.
PORT=8765
SCHEMA=org.gnome.desktop.background
APP=gnome-air-raid-map
SERVICE=$APP.service
FAILED=$APP-failed.service
TIMER=$APP.timer
FIXTURE=/srv/gnome-test-fixture
KEYS=(picture-uri picture-uri-dark picture-options primary-color)
# The known wallpaper from before the install, as gsettings get prints it.
KNOWN=("'file:///srv/known-light.png'" "'file:///srv/known-dark.png'" "'zoom'" "'#336699'")
KNOWN_COLOR='#3a6b35'
MEMORY_MAX=314572800
API=http://127.0.0.1:$PORT
status=0

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

indented() {
    "$@" 2>&1 | sed 's/^/#   /'
    return "${PIPESTATUS[0]}"
}

# The folders of the program, from the XDG variables of the user manager: the
# services and the install script both use them.
xdg_dir() {
    as_user sh -c "printf '%s\n' \"\${$1:-\$HOME/$2}\""
}
APPDIR=$(xdg_dir XDG_DATA_HOME .local/share)/$APP
CACHEDIR=$(xdg_dir XDG_CACHE_HOME .cache)/$APP
STATEDIR=$(xdg_dir XDG_STATE_HOME .local/state)/$APP
UNITDIR=$(xdg_dir XDG_CONFIG_HOME .config)/systemd/user
DROPIN=$UNITDIR/$SERVICE.d
RUNDIR=$TEST_RUNTIME/$APP
BANNER_URI="file://$APPDIR/banner.png"
LIVE_PATH=

keys_are() {
    local i value result=0
    for i in "${!KEYS[@]}"; do
        value=$(as_user gsettings get "$SCHEMA" "${KEYS[i]}")
        echo "#   ${KEYS[i]} $value"
        [ "$value" = "${@:i+1:1}" ] || result=1
    done
    return $result
}

# The keys point to the live picture: picture-uri and picture-uri-dark to the same
# picture*.png file in the runtime folder, and picture-options spanned. Sets LIVE_PATH.
live_keys() {
    local uri dark options path
    uri=$(as_user gsettings get "$SCHEMA" picture-uri)
    dark=$(as_user gsettings get "$SCHEMA" picture-uri-dark)
    options=$(as_user gsettings get "$SCHEMA" picture-options)
    echo "#   picture-uri $uri, picture-uri-dark $dark, picture-options $options"
    path=${uri#"'file://"}
    path=${path%"'"}
    [ "$uri" = "$dark" ] && [ "$options" = "'spanned'" ] && [[ $path == "$RUNDIR"/picture*.png ]] &&
        [ -f "$path" ] || return 1
    LIVE_PATH=$path
}

# Exactly one picture*.png file in the runtime folder.
one_picture() {
    local files
    files=$(find "$RUNDIR" -maxdepth 1 -name 'picture*.png' -printf '%f\n' | sort)
    sed 's/^/#   runtime folder: /' <<< "$files"
    [ "$(grep -c . <<< "$files")" -eq 1 ]
}

banner_keys() {
    keys_are "'$BANNER_URI'" "'$BANNER_URI'" "'centered'" "'#0e1722'"
}

# install_run <name> [--uninstall]: the real install.sh, as the test user.
install_run() {
    local name=$1 code
    shift
    as_user /repo/install.sh "$@" > "$OUT/$name.stdout" 2> "$OUT/$name.stderr"
    code=$?
    sed "s/^/#   $name: /" "$OUT/$name.stdout" "$OUT/$name.stderr"
    return $code
}

prop() {
    user_systemctl show -p "$2" --value "$1"
}

invocation() {
    prop "$1" InvocationID
}

# Prints one line for the last run of a unit, from its systemd properties.
RUN_PROPS=(InvocationID Result ExecMainStatus ExecMainStartTimestamp ExecMainStartTimestampMonotonic
    ExecMainExitTimestampMonotonic MemoryPeak MemorySwapPeak CPUUsageNSec)
record() {
    local -A p=()
    local key value
    while IFS='=' read -r key value; do p[$key]=$value; done < <(user_systemctl show "${RUN_PROPS[@]/#/-p}" "$1")
    local start=${p[ExecMainStartTimestampMonotonic]:-0} end=${p[ExecMainExitTimestampMonotonic]:-0}
    printf '%s %s result=%s status=%s start="%s" start_us=%s seconds=%s peak=%s swap_peak=%s cpu_ns=%s\n' \
        "$1" "${p[InvocationID]:--}" "${p[Result]:--}" "${p[ExecMainStatus]:--}" \
        "${p[ExecMainStartTimestamp]:--}" "$start" \
        "$(awk -v a="$start" -v b="$end" 'BEGIN { printf "%.2f", (b - a) / 1e6 }')" \
        "${p[MemoryPeak]:--}" "${p[MemorySwapPeak]:--}" "${p[CPUUsageNSec]:--}" | tee -a "$OUT/runs.txt"
}

# field <record> <name>: one value of a record line.
field() {
    sed -n "s/.* $2=\"\{0,1\}\([^\" ]*\).*/\1/p" <<< "$1"
}

# wait_run <unit> <old invocation> <seconds>: waits until a run of <unit> other
# than <old invocation> has ended, then prints its record.
wait_run() {
    local unit=$1 old=$2 i id
    for ((i = 0; i < $3 * 2; i++)); do
        id=$(invocation "$unit")
        if [ -n "$id" ] && [ "$id" != "$old" ]; then
            case $(prop "$unit" ActiveState) in
                inactive | failed) record "$unit"; return 0 ;;
            esac
        fi
        sleep 0.5
    done
    echo "timeout: no new run of $unit in $3 s" >&2
    return 1
}

# wait_started <unit> <old invocation> <seconds>: waits until a new run is active.
wait_started() {
    local i id
    for ((i = 0; i < $3 * 4; i++)); do
        id=$(invocation "$1")
        if [ -n "$id" ] && [ "$id" != "$2" ] && [ "$(prop "$1" ActiveState)" = activating ]; then
            return 0
        fi
        sleep 0.25
    done
    return 1
}

wait_idle() {
    local i
    for ((i = 0; i < 120; i++)); do
        [ "$(prop "$SERVICE" ActiveState)" != activating ] && return 0
        sleep 0.25
    done
    return 1
}

result_is() {
    [ "$(field "$1" result)" = "$2" ]
}

# dropin <file> <line ...>: a [Service] drop-in of the updater service, then daemon-reload.
dropin() {
    local file=$1
    shift
    as_user_bare mkdir -p "$DROPIN"
    as_user_bare sh -c 'file=$1; shift; printf "%s\n" "[Service]" "$@" > "$file"' sh "$DROPIN/$file" "$@"
    user_systemctl daemon-reload
    # A daemon-reload makes the timer start a run about 1 s later; let it start first.
    sleep 2
}

no_dropins() {
    as_user_bare rm -rf "$DROPIN"
    user_systemctl daemon-reload
}

# state_edit <js>: changes the state file of the updater, as the test user. The
# JavaScript changes the object s. Call it when no run is active. The eval only runs
# the literal JavaScript of this scenario (in a disposable container), never data.
state_edit() {
    as_user_bare gjs -c '
        const GLib = imports.gi.GLib;
        const path = ARGV[0];
        const s = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(path)[1]));
        eval(ARGV[1]);
        GLib.file_set_contents(path, JSON.stringify(s));' "$RUNDIR/state.json" "$1"
}

# journal_excerpt <step> <since epoch>: the journal lines of the units since a time.
journal_excerpt() {
    user_journal -o short-iso-precise --since "@$2" -u "$SERVICE" -u "$FAILED" -u "$TIMER" \
        -u graphical-session.target -u gnome-test-session.target > "$OUT/journal-$1.txt" 2>&1
    sed 's/^/#   journal: /' "$OUT/journal-$1.txt" | tail -n 25
}

# journal_lines <since epoch> <unit>: the messages of the unit since the time. The
# status is the status of journalctl, so a failed read is a failed check.
journal_lines() {
    user_journal -q -o cat --since "@$1" -u "$2"
}

# live_step <name>: the keys, one picture file, a screenshot, and compare.js.
live_step() {
    check "$1: the wallpaper keys point to the live picture (picture*.png in the runtime folder), spanned" live_keys
    check "$1: one picture file in the runtime folder" one_picture
    [ -n "$LIVE_PATH" ] && cp "$LIVE_PATH" "$OUT/$1-picture.png"
    gjs -c '
        const GLib = imports.gi.GLib;
        const state = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(ARGV[0])[1]));
        print(JSON.stringify(state.layout));' "$RUNDIR/state.json" > "$OUT/$1-layout.json"
    screenshot "$OUT/$1.png" || status=1
    check "$1.png shows the live picture" \
        indented gjs -m /repo/tests/gnome/compare.js "$OUT/$1-picture.png" "$OUT/$1.png" "$OUT/$1-layout.json"
}

# banner_step <name>: the keys and a screenshot of the failure banner.
banner_step() {
    check "$1: the wallpaper keys point to the banner, centered, #0e1722" banner_keys
    sleep 1
    screenshot "$OUT/$1.png" || status=1
    check "$1.png shows the banner centered on #0e1722" \
        indented gjs -m /repo/tests/gnome/scenarios/centered.js "$OUT/$1.png" "$OUT/monitors.json" '#0e1722' "$APPDIR/banner.png"
}

# The next good run after the drop-ins are gone puts the live picture back.
restore_step() {
    local before rec
    no_dropins
    wait_idle
    before=$(invocation "$SERVICE")
    rec=$(wait_run "$SERVICE" "$before" 45)
    check "$1: the next timer run without the drop-in exits 0" result_is "$rec" success
    sleep 1
    live_step "$1"
}

# The dconf Change calls on the session bus of the test user: one for each
# gsettings set, also when the value does not change (the dconf database file does
# not change then, so only the bus shows the call).
dconf_count() {
    grep -c 'Member=Change' "$OUT/dconf-changes.txt"
}

# Step 0: the fixture server (a root service of the container), the known wallpaper.
mkdir -p "$FIXTURE"
gjs -m /repo/tests/gnome/scenarios/fixture.js "$FIXTURE" || exit 1
systemd-run --quiet --unit=gnome-test-fixture gjs -m /repo/tests/lib/fixture-server.js "$PORT" "$FIXTURE" || exit 1
for ((i = 0; i < 40; i++)); do
    (exec 5<> "/dev/tcp/127.0.0.1/$PORT") 2> /dev/null && break
    sleep 0.25
done
user_systemctl set-environment "AIR_RAID_MAP_API_BASE=$API"
for picture in /srv/known-light.png /srv/known-dark.png; do
    gjs -c '
        const Cairo = imports.cairo;
        const surface = new Cairo.ImageSurface(Cairo.Format.RGB24, 64, 64);
        const cr = new Cairo.Context(surface);
        cr.setSourceRGB(0x3a / 255, 0x6b / 255, 0x35 / 255);
        cr.paint();
        cr.$dispose();
        surface.writeToPNG(ARGV[0]);
        surface.finish();' "$picture" || exit 1
    chmod 644 "$picture"
done
as_user gjs -c '
    const Gio = imports.gi.Gio;
    const settings = new Gio.Settings({schema_id: "org.gnome.desktop.background"});
    settings.delay();
    settings.set_string("picture-uri", "file:///srv/known-light.png");
    settings.set_string("picture-uri-dark", "file:///srv/known-dark.png");
    settings.set_string("picture-options", "zoom");
    settings.set_string("primary-color", "#336699");
    settings.apply();
    Gio.Settings.sync();'
shell_eval 'Main.layoutManager.monitors.map(m => [m.x, m.y, m.width, m.height, m.geometry_scale])' > "$OUT/monitors.json"
echo "# Shell monitors [x, y, width, height, scale]: $(cat "$OUT/monitors.json")"
echo "# user manager environment: $(user_systemctl show-environment | tr '\n' ' ')"
echo "# program $APPDIR, units $UNITDIR, cache $CACHEDIR, state $STATEDIR, runtime $RUNDIR"
: > "$OUT/runs.txt"

# Step a: install with no graphical session (M3), log in, four timer runs.
check "a: the known wallpaper is set" keys_are "${KNOWN[@]}"
stop_session
check "a: graphical-session.target is inactive (logged out)" \
    test "$(prop graphical-session.target ActiveState)" = inactive
check "a: install.sh exits 0 with no graphical session" install_run install
check "a: install.sh says that the map starts at the next graphical login" \
    grep -q 'No graphical session runs now' "$OUT/install.stdout"
check "a: the timer is enabled (graphical-session.target.wants)" \
    test -L "$UNITDIR/graphical-session.target.wants/$TIMER"
check "a: the timer is enabled but not active" \
    test "$(prop "$TIMER" UnitFileState)/$(prop "$TIMER" ActiveState)" = enabled/inactive
before=$(invocation "$SERVICE")
sleep 35
check "a: no run while logged out (35 s)" test "$(invocation "$SERVICE")" = "$before"
since=$(date +%s)
start_session || { echo "not ok - a: the session starts"; exit 1; }
session_us=$(prop graphical-session.target ActiveEnterTimestampMonotonic)
check "a: after the login the timer is active" test "$(prop "$TIMER" ActiveState)" = active
starts=() results=()
for n in 1 2 3 4; do
    rec=$(wait_run "$SERVICE" "$before" 45) || { echo "not ok - a: timer run $n"; status=1; break; }
    echo "#   run $n: $rec"
    before=$(awk '{ print $2 }' <<< "$rec")
    starts+=("$(field "$rec" start_us)")
    results+=("$(field "$rec" result)/$(field "$rec" status)")
done
journal_excerpt a "$since"
first_delay=$(awk -v a="$session_us" -v b="${starts[0]:-0}" 'BEGIN { printf "%.2f", (b - a) / 1e6 }')
echo "#   first run $first_delay s after graphical-session.target"
check "a: the first run starts within 3 s of graphical-session.target" \
    awk -v d="$first_delay" 'BEGIN { exit !(d >= 0 && d <= 3) }'
intervals=()
for ((n = 1; n < ${#starts[@]}; n++)); do
    intervals+=("$(awk -v a="${starts[n - 1]}" -v b="${starts[n]}" 'BEGIN { printf "%.2f", (b - a) / 1e6 }')")
done
echo "#   seconds from one run start to the next: ${intervals[*]}"
check "a: 4 runs, each 29-33 s after the previous one" \
    awk -v list="${intervals[*]}" 'BEGIN { n = split(list, v, " "); if (n != 3) exit 1;
        for (i = 1; i <= n; i++) if (v[i] < 29 || v[i] > 33) exit 1 }'
check "a: each run exits 0 (result/status: ${results[*]})" \
    test "${results[*]}" = "success/0 success/0 success/0 success/0"
live_step a-live
first_picture=$LIVE_PATH
# The timer stops and starts with the session.
wait_idle
stop_session
check "a: after a logout the timer is inactive" test "$(prop "$TIMER" ActiveState)" = inactive
before=$(invocation "$SERVICE")
start_session || { echo "not ok - a: the session starts again"; exit 1; }
session_us=$(prop graphical-session.target ActiveEnterTimestampMonotonic)
rec=$(wait_run "$SERVICE" "$before" 10)
check "a: after the next login a run starts within 3 s and exits 0" \
    awk -v a="$session_us" -v b="$(field "$rec" start_us)" -v r="$(field "$rec" result)" \
        'BEGIN { d = (b - a) / 1e6; exit !(r == "success" && d >= 0 && d <= 3) }'
# GVfs writes no metadata for the picture (updater/writer.js uses GLib.rename).
ls -l --time-style=+%T "$(xdg_dir XDG_DATA_HOME .local/share)/gvfs-metadata" 2>&1 | sed 's/^/# a: information: gvfs-metadata: /'

# Step b: OnFailure= after a failed run, failed.sh on the next failure, the live picture again.
as_user busctl --user monitor --match 'type=method_call,interface=ca.desrt.dconf.Writer,member=Change' \
    > "$OUT/dconf-changes.txt" 2>&1 &
sleep 1
since=$(date +%s)
before_failed=$(invocation "$FAILED")
dropin test-break.conf "Environment=AIR_RAID_MAP_DISPLAY=broken"
wait_idle
# Without a saved layout, a run with a broken display fails (spec 5.6, "No layout").
# The state file keeps the name of the live picture.
state_edit 'delete s.displayState'
before=$(invocation "$SERVICE")
rec=$(wait_run "$SERVICE" "$before" 45)
check "b: the run with a broken display fails (Result=exit-code, status 1)" \
    test "$(field "$rec" result)/$(field "$rec" status)" = exit-code/1
before=$(awk '{ print $2 }' <<< "$rec")
rec=$(wait_run "$FAILED" "$before_failed" 10)
check "b: OnFailure= ran $FAILED, and it exits 0" result_is "$rec" success
before_failed=$(awk '{ print $2 }' <<< "$rec")
banner_step b-banner
changes=$(dconf_count)
echo "#   dconf Change calls until the banner: $changes (failed.sh sets each key that differs)"
check "b: the first failure unit run changed the keys (dconf Change calls: $changes)" test "$changes" -ge 1
# The second failure: the keys show the banner already.
rec=$(wait_run "$SERVICE" "$before" 45)
check "b: the next run fails too" test "$(field "$rec" result)/$(field "$rec" status)" = exit-code/1
rec=$(wait_run "$FAILED" "$before_failed" 10)
check "b: OnFailure= ran $FAILED again, and it exits 0" result_is "$rec" success
sleep 1
check "b: the second failure unit run made no dconf Change call ($changes before, $(dconf_count) after)" \
    test "$(dconf_count)" -eq "$changes"
journal_excerpt b "$since"
restore_step b-live
check "b-live: the live picture has a new file name after the banner (${first_picture##*/} -> ${LIVE_PATH##*/})" \
    test -n "$LIVE_PATH" -a "$LIVE_PATH" != "$first_picture"
check "b-live: the dconf monitor saw the change back to the live picture ($(dconf_count) calls)" \
    test "$(dconf_count)" -gt "$changes"
pkill -u "$TEST_USER" -f 'busctl --user monitor'

# Step c: the limits of the service.
check "c: MemoryMax=$MEMORY_MAX (300M)" test "$(prop "$SERVICE" MemoryMax)" = $MEMORY_MAX
check "c: MemorySwapMax=0" test "$(prop "$SERVICE" MemorySwapMax)" = 0
check "c: TimeoutStartUSec=25s" test "$(prop "$SERVICE" TimeoutStartUSec)" = 25s
check "c: OnFailure=$FAILED" test "$(prop "$SERVICE" OnFailure)" = "$FAILED"
echo "#   SuccessExitStatus=$(prop "$SERVICE" SuccessExitStatus)"
check "c: SuccessExitStatus has SIGTERM" sh -c 'case $1 in *TERM*|*15*) ;; *) exit 1 ;; esac' sh \
    "$(prop "$SERVICE" SuccessExitStatus)"
since=$(date +%s)
before_failed=$(invocation "$FAILED")
dropin test-hang.conf "TimeoutStartSec=5s" "Environment=AIR_RAID_MAP_API_BASE=$API/hang"
check "c: the drop-in sets TimeoutStartUSec=5s" test "$(prop "$SERVICE" TimeoutStartUSec)" = 5s
wait_idle
before=$(invocation "$SERVICE")
if wait_started "$SERVICE" "$before" 45; then
    cgroup=$(prop "$SERVICE" ControlGroup)
    echo "#   cgroup $cgroup: memory.max $(cat "/sys/fs/cgroup$cgroup/memory.max"), memory.swap.max $(cat "/sys/fs/cgroup$cgroup/memory.swap.max" 2> /dev/null || echo -)"
    check "c: the kernel limits of the running service are memory.max $MEMORY_MAX and memory.swap.max 0" \
        test "$(cat "/sys/fs/cgroup$cgroup/memory.max")/$(cat "/sys/fs/cgroup$cgroup/memory.swap.max")" = "$MEMORY_MAX/0"
else
    echo "not ok - c: a timer run starts"
    status=1
fi
rec=$(wait_run "$SERVICE" "$before" 20)
check "c: systemd stops the run that waits for the server at 5 s (Result=timeout, a failure)" result_is "$rec" timeout
rec=$(wait_run "$FAILED" "$before_failed" 10)
check "c: OnFailure= ran $FAILED after the timeout, and it exits 0" result_is "$rec" success
banner_step c-banner
journal_excerpt c-timeout "$since"

since=$(date +%s)
as_user_bare rm -f "$DROPIN/test-hang.conf"
dropin test-hang.conf "Environment=AIR_RAID_MAP_API_BASE=$API/hang"
wait_idle
before=$(invocation "$SERVICE")
rec=$(wait_run "$SERVICE" "$before" 75)
seconds=$(field "$rec" seconds)
check "c: with TimeoutStartSec=25s, the 15 s request deadline ends the same run first: exit 0 after $seconds s" \
    awk -v r="$(field "$rec" result)" -v s="$seconds" 'BEGIN { exit !(r == "success" && s >= 14 && s < 25) }'
journal_excerpt c-deadline "$since"

# systemctl stop during a run (the run waits for the server): a clean stop.
since=$(date +%s)
wait_idle
before=$(invocation "$SERVICE")
before_failed=$(invocation "$FAILED")
if wait_started "$SERVICE" "$before" 45; then
    sleep 2
    user_systemctl stop "$SERVICE"
    echo "#   after systemctl stop: Result=$(prop "$SERVICE" Result), ExecMainCode=$(prop "$SERVICE" ExecMainCode), ExecMainStatus=$(prop "$SERVICE" ExecMainStatus), ActiveState=$(prop "$SERVICE" ActiveState)"
    check "c: systemctl stop during a run: Result=success, not failed" \
        test "$(prop "$SERVICE" Result)/$(prop "$SERVICE" ActiveState)" = success/inactive
    sleep 3
    check "c: systemctl stop during a run: the failure unit did not run" \
        test "$(invocation "$FAILED")" = "$before_failed"
else
    echo "not ok - c: a timer run starts (for systemctl stop)"
    status=1
fi
journal_excerpt c-stop "$since"

since=$(date +%s)
as_user_bare rm -f "$DROPIN/test-hang.conf"
# A run that draws the whole picture uses the most memory: forget the render key.
dropin test-memory.conf "MemoryMax=20M"
wait_idle
state_edit 's.renderKey = ""'
before=$(invocation "$SERVICE")
rec=$(wait_run "$SERVICE" "$before" 45)
echo "#   $rec"
echo "# c: information: MemoryMax=20M (MemorySwapMax=0 from the unit): result $(field "$rec" result)," \
    "MemoryPeak $(field "$rec" peak), MemorySwapPeak $(field "$rec" swap_peak)"
# The oom-kill check: 4M is less than gjs needs to start, on both images. (A run of
# this scenario fits in 20M on Ubuntu 24.04: the synthetic map is small. systemd 255
# also shows a wrong MemoryPeak after a run, so the peak cannot choose the limit.)
# If the 20M run failed, its failure unit runs now: let it end first.
wait_idle
sleep 2
before_failed=$(invocation "$FAILED")
dropin test-memory.conf "MemoryMax=4M"
wait_idle
before=$(invocation "$SERVICE")
rec=$(wait_run "$SERVICE" "$before" 45)
echo "#   $rec"
check "c: MemoryMax=4M: the kernel stops the run (Result=oom-kill, a failure)" result_is "$rec" oom-kill
rec=$(wait_run "$FAILED" "$before_failed" 10)
check "c: OnFailure= ran $FAILED after the oom-kill, and it exits 0" result_is "$rec" success
banner_step c-oom-banner
journal_excerpt c-memory "$since"
restore_step c-live

# Step f: no temporary files from the runs (killed, stopped or normal).
no_temp_files() {
    local found
    found=$(find "$RUNDIR" "$CACHEDIR" "$STATEDIR" "$APPDIR" \( -name '.goutputstream-*' -o -name '*.tmp' \) 2>&1)
    [ -z "$found" ] || sed 's/^/#   temporary file: /' <<< "$found"
    [ -z "$found" ]
}
check "f: no .goutputstream-* or *.tmp file in the runtime, cache, state and data folders" no_temp_files
# Information: a lost state file (it is in RAM) gives a first run, with a new picture
# name; the run does not know the old picture file, so the file stays until logout.
wait_idle
as_user_bare rm -f "$RUNDIR/state.json"
before=$(invocation "$SERVICE")
rec=$(wait_run "$SERVICE" "$before" 45)
echo "# f: information: after a lost state file, the next run: result $(field "$rec" result); runtime folder:" \
    "$(find "$RUNDIR" -maxdepth 1 -name 'picture*.png' -printf '%f ')"

# Step d: uninstall.
since=$(date +%s)
wait_idle
check "d: install.sh --uninstall exits 0" install_run uninstall --uninstall
# A run that the uninstall stopped can have started in the same second: count from the next second.
after=$(($(date +%s) + 1))
check "d: the four keys have the known values again" keys_are "${KNOWN[@]}"
no_program_files() {
    local left
    left=$(find "$TEST_HOME" "$TEST_RUNTIME" -name "*$APP*" 2> /dev/null)
    [ -z "$left" ] || sed 's/^/#   left: /' <<< "$left"
    [ -z "$left" ]
}
check "d: no file or folder of the program in $TEST_HOME and $TEST_RUNTIME" no_program_files
check "d: the program, cache, state and runtime folders are gone" \
    sh -c '! ls -d "$@" 2> /dev/null' sh "$APPDIR" "$CACHEDIR" "$STATEDIR" "$RUNDIR"
check "d: systemd has no unit file of the program" \
    test -z "$(user_systemctl list-unit-files --no-legend "$APP*")"
check "d: the timer is not loaded" test "$(prop "$TIMER" LoadState)" = not-found
# The journal read must work: it shows the stop of the timer by the uninstall.
timer_stopped() {
    local lines
    lines=$(journal_lines "$1" "$TIMER") || { echo "#   journalctl failed"; return 1; }
    grep -q "^Stopped $TIMER" <<< "$lines"
}
no_start_after() {
    local lines
    lines=$(journal_lines "$1" "$2") || { echo "#   journalctl failed"; return 1; }
    [ -z "$lines" ] || sed "s/^/#   $2 after the uninstall: /" <<< "$lines"
    ! grep -q '^Starting ' <<< "$lines"
}
sleep 35
check "d: the journal shows that the uninstall stopped the timer" timer_stopped "$since"
check "d: no run in 35 s after the uninstall" no_start_after "$after" "$SERVICE"
screenshot "$OUT/d-restored.png" || status=1
check "d-restored.png shows the known wallpaper" \
    indented gjs -m /repo/tests/gnome/scenarios/centered.js "$OUT/d-restored.png" "$OUT/monitors.json" "$KNOWN_COLOR"
journal_excerpt d "$since"

# Step e (review finding C1): the uninstall during a run.
no_onfailure_after() {
    local lines
    lines=$(journal_lines "$1" "$SERVICE") || { echo "#   journalctl failed"; return 1; }
    sed 's/^/#   service after the uninstall began: /' <<< "$lines"
    ! grep -q 'Triggering OnFailure' <<< "$lines"
}
check "e: install.sh exits 0 (session active)" install_run install-e
before=
rec=$(wait_run "$SERVICE" "$before" 15)
check "e: the first run after the install exits 0" result_is "$rec" success
user_systemctl set-environment "AIR_RAID_MAP_API_BASE=$API/hang"
before=$(awk '{ print $2 }' <<< "$rec")
before_failed=$(invocation "$FAILED")
if wait_started "$SERVICE" "$before" 45; then
    sleep 2
    check "e: a run is in progress (it waits for the server)" test "$(prop "$SERVICE" ActiveState)" = activating
    since=$(date +%s)
    check "e: install.sh --uninstall during the run exits 0" install_run uninstall-e --uninstall
    check "e: the four keys have the known values again, not the banner" keys_are "${KNOWN[@]}"
    sleep 10
    check "e: 10 s later the keys still have the known values" keys_are "${KNOWN[@]}"
    check "e: the journal shows that the uninstall stopped the timer" timer_stopped "$since"
    check "e: no run of $FAILED after the uninstall began" no_start_after "$since" "$FAILED"
    check "e: no OnFailure= after the uninstall began" no_onfailure_after "$since"
    check "e: no file or folder of the program in $TEST_HOME and $TEST_RUNTIME" no_program_files
else
    echo "not ok - e: a timer run starts (for the uninstall during a run)"
    status=1
fi
user_systemctl set-environment "AIR_RAID_MAP_API_BASE=$API"
screenshot "$OUT/e-restored.png" || status=1
check "e-restored.png shows the known wallpaper" \
    indented gjs -m /repo/tests/gnome/scenarios/centered.js "$OUT/e-restored.png" "$OUT/monitors.json" "$KNOWN_COLOR"
journal_excerpt e "${since:-0}"

echo "# systemd: $status (0: every check passed)"
exit $status
