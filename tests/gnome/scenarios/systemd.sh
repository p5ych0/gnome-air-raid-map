# Scenario: the real systemd user units (plan Task 11). Sourced by session-systemd.sh,
# as root, in a container where systemd is PID 1 (tests/gnome/run-systemd.sh). The
# real install.sh runs as the test user with the environment of its user manager.
# The timer of the user manager starts every run; nothing runs the updater by hand.
# The updater gets its data from the local fixture server (fixture.js), through
# AIR_RAID_MAP_API_BASE in the user manager environment (systemctl --user set-environment).
# Steps:
#   a  install; log out (the timer stops) and log in again; the timer starts a run at
#      session start and then every ~30 s; 4 runs exit 0; the screen shows the live picture.
#   b  a drop-in breaks the display (AIR_RAID_MAP_DISPLAY=broken) and the saved
#      layout is deleted: the run fails, OnFailure= sets the banner; without the
#      drop-in the next run puts the live picture back.
#   c  MemoryMax and TimeoutStartSec of the service; the kernel limit of a running
#      run; a drop-in with TimeoutStartSec=5s and a server that never answers: systemd
#      stops the run, and OnFailure= sets the banner; the same server with
#      TimeoutStartSec=25s: the 15 s request deadline ends the run first (exit 0);
#      MemoryMax=20M with swap (information only); MemoryMax=4M without swap (oom-kill, banner);
#      then the live picture again.
#   d  uninstall: the wallpaper from before the install, no file of the program in
#      the home and runtime folders, no unit, no run after the uninstall.
# Prints "ok - <check>" or "not ok - <check>" for each check, and "#" lines.
# Files: a-live.png, b-banner.png, b-live.png, c-banner.png, c-oom-banner.png,
# c-live.png, d-restored.png (screenshots); <name>-picture.png and <name>-layout.json
# (for compare.js); journal-<step>.txt (journalctl --user excerpts); runs.txt (one
# line for each run that the scenario waited for); install.*, uninstall.*.
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
LIVE_URI="file://$RUNDIR/picture.png"
BANNER_URI="file://$APPDIR/banner.png"

keys_are() {
    local i value result=0
    for i in "${!KEYS[@]}"; do
        value=$(as_user gsettings get "$SCHEMA" "${KEYS[i]}")
        echo "#   ${KEYS[i]} $value"
        [ "$value" = "${@:i+1:1}" ] || result=1
    done
    return $result
}

live_keys() {
    local uri dark options
    uri=$(as_user gsettings get "$SCHEMA" picture-uri)
    dark=$(as_user gsettings get "$SCHEMA" picture-uri-dark)
    options=$(as_user gsettings get "$SCHEMA" picture-options)
    echo "#   picture-uri $uri, picture-uri-dark $dark, picture-options $options"
    [ "$uri" = "'$LIVE_URI'" ] && [ "$dark" = "'$LIVE_URI'" ] && [ "$options" = "'spanned'" ]
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

# journal_excerpt <step> <since epoch>: the journal lines of the units since a time.
journal_excerpt() {
    user_journal -o short-iso-precise --since "@$2" -u "$SERVICE" -u "$FAILED" -u "$TIMER" \
        -u graphical-session.target -u gnome-test-session.target > "$OUT/journal-$1.txt" 2>&1
    sed 's/^/#   journal: /' "$OUT/journal-$1.txt" | tail -n 25
}

# live_step <name>: the keys, a screenshot, and compare.js with the picture of the last run.
live_step() {
    check "$1: the wallpaper keys point to the live picture, spanned" live_keys
    cp "$RUNDIR/picture.png" "$OUT/$1-picture.png"
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

# Step 0: the fixture server (a root service of the container), the known wallpaper.
mkdir -p "$FIXTURE"
gjs -m /repo/tests/gnome/scenarios/fixture.js "$FIXTURE" || exit 1
systemd-run --quiet --unit=gnome-test-fixture gjs -m /repo/tests/lib/fixture-server.js "$PORT" "$FIXTURE" || exit 1
for ((i = 0; i < 40; i++)); do
    (exec 5<> "/dev/tcp/127.0.0.1/$PORT") 2> /dev/null && break
    sleep 0.25
done
user_systemctl set-environment "AIR_RAID_MAP_API_BASE=http://127.0.0.1:$PORT"
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

# Step a: install, log out, log in, four timer runs.
check "a: the known wallpaper is set" keys_are "${KNOWN[@]}"
check "a: install.sh exits 0" install_run install
check "a: the timer is active after the install" user_systemctl is-active --quiet "$TIMER"
check "a: the timer is enabled in graphical-session.target.wants" \
    test -L "$UNITDIR/graphical-session.target.wants/$TIMER"
stop_session
check "a: after logout the timer is inactive" test "$(prop "$TIMER" ActiveState)" = inactive
before=$(invocation "$SERVICE")
sleep 35
check "a: no run while logged out (35 s)" test "$(invocation "$SERVICE")" = "$before"
since=$(date +%s)
start_session || { echo "not ok - a: the session starts again"; exit 1; }
session_us=$(prop graphical-session.target ActiveEnterTimestampMonotonic)
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
# Information: Gio.File.move() of the rename method (updater/writer.js) makes GIO
# write a GVfs metadata entry for each new picture.
ls -l --time-style=+%T "$(xdg_dir XDG_DATA_HOME .local/share)/gvfs-metadata" 2>&1 | sed 's/^/# a: information: gvfs-metadata: /'

# Step b: OnFailure= after a failed run, and the live picture again.
since=$(date +%s)
before_failed=$(invocation "$FAILED")
dropin test-break.conf "Environment=AIR_RAID_MAP_DISPLAY=broken"
wait_idle
before=$(invocation "$SERVICE")
# Without a saved layout, a run with a broken display fails (spec 5.6, "No layout").
rm -f "$RUNDIR/state.json"
rec=$(wait_run "$SERVICE" "$before" 45)
check "b: the run with a broken display fails (Result=exit-code, status 1)" \
    test "$(field "$rec" result)/$(field "$rec" status)" = exit-code/1
rec=$(wait_run "$FAILED" "$before_failed" 10)
check "b: OnFailure= ran $FAILED, and it exits 0" result_is "$rec" success
banner_step b-banner
journal_excerpt b "$since"
since=$(date +%s)
restore_step b-live

# Step c: the limits of the service.
check "c: MemoryMax=$MEMORY_MAX (300M)" test "$(prop "$SERVICE" MemoryMax)" = $MEMORY_MAX
check "c: TimeoutStartUSec=25s" test "$(prop "$SERVICE" TimeoutStartUSec)" = 25s
check "c: OnFailure=$FAILED" test "$(prop "$SERVICE" OnFailure)" = "$FAILED"
since=$(date +%s)
before_failed=$(invocation "$FAILED")
dropin test-hang.conf "TimeoutStartSec=5s" "Environment=AIR_RAID_MAP_API_BASE=http://127.0.0.1:$PORT/hang"
check "c: the drop-in sets TimeoutStartUSec=5s" test "$(prop "$SERVICE" TimeoutStartUSec)" = 5s
wait_idle
before=$(invocation "$SERVICE")
if wait_started "$SERVICE" "$before" 45; then
    cgroup=$(prop "$SERVICE" ControlGroup)
    echo "#   cgroup $cgroup: memory.max $(cat "/sys/fs/cgroup$cgroup/memory.max"), memory.swap.max $(cat "/sys/fs/cgroup$cgroup/memory.swap.max" 2> /dev/null || echo -)"
    check "c: the kernel limit of the running service is memory.max $MEMORY_MAX" \
        test "$(cat "/sys/fs/cgroup$cgroup/memory.max")" = $MEMORY_MAX
else
    echo "not ok - c: a timer run starts"
    status=1
fi
rec=$(wait_run "$SERVICE" "$before" 20)
check "c: systemd stops the run that waits for the server at 5 s (Result=timeout)" result_is "$rec" timeout
rec=$(wait_run "$FAILED" "$before_failed" 10)
check "c: OnFailure= ran $FAILED after the timeout, and it exits 0" result_is "$rec" success
banner_step c-banner
journal_excerpt c-timeout "$since"

since=$(date +%s)
as_user_bare rm -f "$DROPIN/test-hang.conf"
dropin test-hang.conf "Environment=AIR_RAID_MAP_API_BASE=http://127.0.0.1:$PORT/hang"
wait_idle
before=$(invocation "$SERVICE")
rec=$(wait_run "$SERVICE" "$before" 75)
seconds=$(field "$rec" seconds)
check "c: with TimeoutStartSec=25s, the 15 s request deadline ends the same run first: exit 0 after $seconds s" \
    awk -v r="$(field "$rec" result)" -v s="$seconds" 'BEGIN { exit !(r == "success" && s >= 14 && s < 25) }'
journal_excerpt c-deadline "$since"

since=$(date +%s)
as_user_bare rm -f "$DROPIN/test-hang.conf"
# A run without the state file draws the whole picture: it uses the most memory.
dropin test-memory.conf "MemoryMax=20M"
wait_idle
rm -f "$RUNDIR/state.json"
before=$(invocation "$SERVICE")
rec=$(wait_run "$SERVICE" "$before" 45)
echo "#   $rec"
echo "# c: information: MemoryMax=20M with swap on: result $(field "$rec" result)," \
    "MemoryPeak $(field "$rec" peak), MemorySwapPeak $(field "$rec" swap_peak) (host swap: $(awk 'NR > 1 { s += $3 } END { print s + 0 }' /proc/swaps) KiB)"
# The oom-kill check: 4M without swap is less than gjs needs to start, on both
# images. (A run of this scenario fits in 20M on Ubuntu 24.04: the synthetic map is
# small. systemd 255 also shows a wrong MemoryPeak after a run, so the peak cannot
# choose the limit.)
before_failed=$(invocation "$FAILED")
dropin test-memory.conf "MemoryMax=4M" "MemorySwapMax=0"
wait_idle
rm -f "$RUNDIR/state.json"
before=$(invocation "$SERVICE")
rec=$(wait_run "$SERVICE" "$before" 45)
echo "#   $rec"
check "c: MemoryMax=4M without swap: the kernel stops the run (Result=oom-kill)" result_is "$rec" oom-kill
rec=$(wait_run "$FAILED" "$before_failed" 10)
check "c: OnFailure= ran $FAILED after the oom-kill, and it exits 0" result_is "$rec" success
banner_step c-oom-banner
journal_excerpt c-memory "$since"
restore_step c-live

# Step d: uninstall.
since=$(date +%s)
wait_idle
check "d: install.sh --uninstall exits 0" install_run uninstall --uninstall
# A run that the uninstall stopped can have started in the same second: count from the next second.
after=$(($(date +%s) + 1))
check "d: the four keys have the known values again" keys_are "${KNOWN[@]}"
left=$(find "$TEST_HOME" "$TEST_RUNTIME" -name "*$APP*" 2> /dev/null)
[ -z "$left" ] || sed 's/^/#   left: /' <<< "$left"
check "d: no file or folder of the program in $TEST_HOME and $TEST_RUNTIME" test -z "$left"
check "d: the program, cache, state and runtime folders are gone" \
    sh -c '! ls -d "$@" 2> /dev/null' sh "$APPDIR" "$CACHEDIR" "$STATEDIR" "$RUNDIR"
check "d: systemd has no unit file of the program" \
    test -z "$(user_systemctl list-unit-files --no-legend "$APP*")"
check "d: the timer is not loaded" test "$(prop "$TIMER" LoadState)" = not-found
# The journal read must work: it shows the stop of the timer by the uninstall.
timer_stopped() {
    local lines
    lines=$(user_journal -q -o cat --since "@$since" -u "$TIMER") || { echo "#   journalctl failed"; return 1; }
    grep -q "^Stopped $TIMER" <<< "$lines"
}
no_run_after() {
    local lines
    lines=$(user_journal -q -o cat --since "@$after" -u "$SERVICE") || { echo "#   journalctl failed"; return 1; }
    [ -z "$lines" ] || sed 's/^/#   after the uninstall: /' <<< "$lines"
    ! grep -q '^Starting ' <<< "$lines"
}
sleep 35
check "d: the journal shows that the uninstall stopped the timer" timer_stopped
check "d: no run in 35 s after the uninstall" no_run_after
screenshot "$OUT/d-restored.png" || status=1
check "d-restored.png shows the known wallpaper" \
    indented gjs -m /repo/tests/gnome/scenarios/centered.js "$OUT/d-restored.png" "$OUT/monitors.json" "$KNOWN_COLOR"
journal_excerpt d "$since"

echo "# systemd: $status (0: every check passed)"
exit $status
