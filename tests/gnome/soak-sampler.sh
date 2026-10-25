#!/bin/bash
# The sampler of the GNOME soak (plan Task 11). scenarios/soak.sh starts it as a
# system service of the container (systemd-run), so it does not depend on the
# Podman client on the host. It runs as root for <seconds>, then stops the
# container (systemctl poweroff; run-systemd.sh starts the container with --rm).
# Usage: soak-sampler.sh <seconds>
# Files in /out (each line is written at once, so a crash keeps the lines before it):
#   samples.tsv  every 60 s: the gnome-shell process of the test session (PID; PSS,
#                its anonymous and shmem parts, and RSS from /proc/<pid>/smaps_rollup;
#                CPU time from /proc/<pid>/stat), all processes of its service (the
#                sum of their PSS, memory.current, usage_usec of cpu.stat: the Shell
#                and its children, such as the glycin image loaders), the line
#                counts of journal.txt and shell-journal.txt, and write_bytes of
#                gvfsd-metadata (/proc/<pid>/io; empty when it does not run): GIO
#                writes a GVfs metadata entry when the updater renames its picture.
#   runs.tsv     every run of gnome-air-raid-map.service and of
#                gnome-air-raid-map-failed.service that ended, from systemctl --user
#                show: start time, result, exit status, run time, MemoryPeak,
#                MemorySwapPeak, CPUUsageNSec. The sampler checks every 5 s; a run
#                starts 30 s after the previous one, so it sees every run.
#   gc.tsv       every GNOME_TEST_SOAK_GC_INTERVAL s (default 3600; the first at that
#                time): a GC probe of the live memory of gnome-shell (spec 7.4, check 5;
#                docs/decisions/2026-10-25-shell-memory.md). glibc keeps the freed
#                picture buffers in gnome-shell, and one garbage collection does not
#                free all dead pictures. So the probe:
#                1. In an updater container, waits until a run of the updater ends (60 s
#                   at most), and then 5 s more. The next run then usually starts after
#                   the probe (see the overlap check below).
#                2. Takes the sample "before".
#                3. Makes 3 proven garbage collections in gnome-shell, through
#                   org.gnome.Shell.Eval (the Shell runs with --unsafe-mode), 2 s apart.
#                   Proof: an Eval creates an object that only a WeakRef holds; a second
#                   Eval runs imports.system.gc() and then checks that the WeakRef is
#                   empty (true). Without a collection, the object stays (false). The
#                   two Evals are two jobs, so the WeakRef does not keep the object.
#                   Samples "gc1" (after the first) and "gc3" (after the third).
#                4. Asks the host for malloc_trim(0) in gnome-shell (the image has no
#                   gdb): it writes /out/trim-request and waits 150 s at most for
#                   /out/trim-result (tests/leak/soak.sh answers it).
#                5. Waits 5 s and takes the sample "trim": the live memory.
#                The timer keeps its cadence, so a run can start during the probe, and a
#                picture change then leaves dead buffers in the samples. So the probe
#                reads the InvocationID and the ActiveState of the updater service before
#                the first sample and after the last one. A run overlapped the probe if
#                the ActiveState is not inactive or failed at the start or at the end, or
#                if the ID changed. A loaded service with no InvocationID at the start (a
#                read that failed) also counts as an overlap. The sampler then discards
#                the probe (sampler.log has a line) and starts it again (steps 1 to 5), 3
#                tries at most. Three overlaps give a line with "updater overlap" in
#                "collected", and summarize.js fails that probe. A failed trim also fails
#                the probe, so the sampler keeps a try with a failed trim and does not
#                try again: the line then gives the reason of the trim failure. The
#                control container has no updater (its service is not loaded) and no
#                check.
#                One line: the start time, gnome-shell PID, "collected" (the result of
#                each collection: true, false or error; or "shell restarted", "updater
#                overlap", or both),
#                gc_passes (the number of proven collections), trim (ok or fail) and
#                trim_detail (the return value of malloc_trim, or the reason of the
#                failure), PSS, anonymous PSS, shmem PSS and RSS of the four samples,
#                and the time of the last sample. The probe runs in the background: the
#                sampler samples and polls as usual.
#   journal.txt        the journalctl --user lines of the two units.
#   shell-journal.txt  the journalctl --user lines of gnome-test-shell.service.
#   journal-user-end.txt  the whole user journal, at the end.
# The control container runs the same sampler: it has no updater, so its runs.tsv
# and journal.txt stay empty, and both containers have the same sampler load.
set -u
OUT=${GNOME_TEST_SOAK_OUT:-/out}
# The folder of the journal cursors (a test gives a folder of its own).
CURSOR_DIR=${GNOME_TEST_SOAK_CURSOR_DIR:-/var/tmp}
seconds=$1
TEST_USER=tester
TEST_UID=$(id -u "$TEST_USER")
TEST_HOME=$(getent passwd "$TEST_USER" | cut -d: -f6)
TEST_RUNTIME=/run/user/$TEST_UID
UNITS=(gnome-air-raid-map.service gnome-air-raid-map-failed.service)
TICKS=$(getconf CLK_TCK)

as_user_bare() {
    runuser -u "$TEST_USER" -- env -i HOME="$TEST_HOME" PATH=/usr/local/bin:/usr/bin:/bin \
        XDG_RUNTIME_DIR="$TEST_RUNTIME" DBUS_SESSION_BUS_ADDRESS="unix:path=$TEST_RUNTIME/bus" "$@"
}

user_show() {
    as_user_bare systemctl --user show "$@"
}

# journal_append <file> <unit ...>: appends the new journal lines of the units.
journal_append() {
    local file=$1 cursor=$CURSOR_DIR/gnome-test-soak-$(basename "$1").cursor
    shift
    as_user_bare journalctl --user --no-pager -q -o short-iso-precise --cursor-file="$cursor" \
        "${@/#/--unit=}" >> "$OUT/$file" 2> /dev/null
}

# memory <pid>: PSS, its anonymous and shmem parts, and RSS, in KB, tab-separated.
memory() {
    awk '/^Pss:/ { p = $2 } /^Pss_Anon:/ { a = $2 } /^Pss_Shmem:/ { s = $2 } /^Rss:/ { r = $2 }
        END { printf "%d\t%d\t%d\t%d", p, a, s, r }' "/proc/$1/smaps_rollup" 2> /dev/null || printf '\t\t\t'
}

shell_pid() {
    local pid
    pid=$(user_show -p MainPID --value gnome-test-shell.service 2> /dev/null)
    echo "${pid:-0}"
}

# shell_eval <js>: prints the result of org.gnome.Shell.Eval, or "error".
shell_eval() {
    local reply
    reply=$(as_user_bare gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1" 2> /dev/null) || { echo error; return; }
    case $reply in
        "(true, '"*"')") reply=${reply#"(true, '"}; echo "${reply%"')"}" ;;
        *) echo error ;;
    esac
}

# The GC probe (see gc.tsv above).
GC_PASSES=3
# A probe that an updater run overlaps is discarded and tried again, 3 tries at most.
PROBE_TRIES=3
GC_PASS_WAIT=2
TRIM_WAIT=150
# The last probe starts PROBE_MARGIN s before the end at the latest. A try waits 226 s at
# most: 60 s for the end of a run, 150 s for the trim, and 16 s more. Its commands add a
# few seconds when the Shell answers the Evals. So 3 tries take less than 720 s (3 tries
# of 240 s), and a probe ends before the end of the sampler. A Shell that does not answer
# adds up to 25 s for each Eval (the D-Bus timeout of gdbus).
PROBE_MARGIN=${GNOME_TEST_SOAK_PROBE_MARGIN:-720}

# One proven garbage collection in gnome-shell: prints true, false or error.
gc_pass() {
    shell_eval 'globalThis.__soakProbe = new WeakRef({}); true' > /dev/null
    shell_eval 'imports.system.gc(); globalThis.__soakProbe.deref() === undefined'
}

# In an updater container: waits until a run of the updater ends, 60 s at most. A run
# starts every 30 s and takes about 0.5 s, so the probe that follows usually has no picture
# change.
wait_run_end() {
    local unit=${UNITS[0]} id0 state0 id state i
    id0=$(user_show -p InvocationID --value "$unit" 2> /dev/null)
    [ -n "$id0" ] || return 0
    state0=$(user_show -p ActiveState --value "$unit" 2> /dev/null)
    for ((i = 0; i < 60; i++)); do
        id=$(user_show -p InvocationID --value "$unit" 2> /dev/null)
        state=$(user_show -p ActiveState --value "$unit" 2> /dev/null)
        case $state in
            inactive | failed)
                # A new run that ended, or the end of the run that was active at the start.
                if [ "$id" != "$id0" ] || [ "$state0" = activating ]; then return 0; fi ;;
        esac
        sleep 1
    done
}

# trim_request <pid>: asks tests/leak/soak.sh on the host for malloc_trim(0) in gnome-shell
# and waits for the answer. Prints "ok TAB <detail>" or "fail TAB <detail>".
trim_request() {
    local id i rid status detail
    id=$(date +%s%N)
    printf '%s\t%s\n' "$id" "$1" > "$OUT/trim-request.tmp" && mv -f "$OUT/trim-request.tmp" "$OUT/trim-request"
    for ((i = 0; i < TRIM_WAIT; i++)); do
        sleep 1
        [ -s "$OUT/trim-result" ] && IFS=$'\t' read -r rid status detail < "$OUT/trim-result" || continue
        if [ "$rid" = "$id" ]; then
            printf '%s\t%s' "$status" "$detail"
            return
        fi
    done
    printf 'fail\tno answer from the host in %s s (tests/leak/soak.sh answers the trim requests)' "$TRIM_WAIT"
}

# overlapped <id> <state> <load>: succeeds if an updater run overlapped a try of a probe
# that started with the InvocationID id, the ActiveState state and the LoadState load: a
# run was active at the start, the ID changed, or a run is active now. An empty id with
# the load "loaded" is a start read that failed: that try counts as overlapped. An empty
# id of a service that is not loaded is the control container, which has no updater.
overlapped() {
    local unit=${UNITS[0]} id state
    if [ -z "$1" ]; then
        [ "$3" = loaded ]
        return
    fi
    case $2 in inactive | failed) ;; *) return 0 ;; esac
    id=$(user_show -p InvocationID --value "$unit" 2> /dev/null)
    state=$(user_show -p ActiveState --value "$unit" 2> /dev/null)
    [ "$id" = "$1" ] || return 0
    case $state in inactive | failed) return 1 ;; *) return 0 ;; esac
}

# One GC probe and its line in gc.tsv. It runs in the background.
gc_probe() {
    local pid epoch before gc1 gc3 trim after results passes result i try id0 state0 load0 key value kept=0 reasons=()
    for ((try = 1; try <= PROBE_TRIES; try++)); do
        results=() passes=0
        wait_run_end
        sleep 5
        # The InvocationID, the ActiveState and the LoadState at the start of the try, from
        # one read.
        id0='' state0='' load0=''
        while IFS='=' read -r key value; do
            case $key in InvocationID) id0=$value ;; ActiveState) state0=$value ;; LoadState) load0=$value ;; esac
        done < <(user_show -p InvocationID -p ActiveState -p LoadState "${UNITS[0]}" 2> /dev/null)
        pid=$(shell_pid)
        epoch=$(date +%s)
        before=$(memory "$pid")
        for ((i = 1; i <= GC_PASSES; i++)); do
            result=$(gc_pass)
            results+=("$result")
            [ "$result" != true ] || passes=$((passes + 1))
            sleep "$GC_PASS_WAIT"
            [ $i -ne 1 ] || gc1=$(memory "$pid")
        done
        gc3=$(memory "$pid")
        trim=$(trim_request "$pid")
        sleep 5
        after=$(memory "$pid")
        # The line keeps this try (kept=1) if no run overlapped it, or if its trim failed:
        # a failed trim fails the probe anyway, and another try would only hide the reason.
        if [ "${trim%%$'\t'*}" != ok ] || ! overlapped "$id0" "$state0" "$load0"; then kept=1; break; fi
        echo "$(date -Is) GC probe try $try of $PROBE_TRIES: an updater run overlapped it; the sample is discarded" \
            >> "$OUT/sampler.log"
    done
    [ "$(shell_pid)" = "$pid" ] || reasons+=("shell restarted")
    [ $kept -eq 1 ] || reasons+=("updater overlap")
    [ ${#reasons[@]} -eq 0 ] || results=("${reasons[@]}")
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$epoch" "$((epoch - start))" "$pid" \
        "$(IFS=,; echo "${results[*]}")" "$passes" "$trim" "$before" "$gc1" "$gc3" "$after" "$(date +%s)" \
        >> "$OUT/gc.tsv"
}

sample() {
    local now pid memory='' cpu='' cgroup group_pss=0 group_mem='' group_cpu='' p metadata
    now=$(date +%s)
    pid=$(shell_pid)
    if [ "$pid" -gt 0 ] && [ -r "/proc/$pid/stat" ]; then
        memory=$(memory "$pid")
        # Fields 14 and 15 of /proc/<pid>/stat: utime and stime in clock ticks.
        cpu=$(awk -v t="$TICKS" '{ sub(/^.*\) /, ""); printf "%.2f", ($12 + $13) / t }' "/proc/$pid/stat")
    else
        pid=0 memory=$'\t\t\t'
    fi
    cgroup=$(user_show -p ControlGroup --value gnome-test-shell.service 2> /dev/null)
    if [ -n "$cgroup" ] && [ -d "/sys/fs/cgroup$cgroup" ]; then
        for p in $(cat "/sys/fs/cgroup$cgroup/cgroup.procs"); do
            group_pss=$((group_pss + $(awk '/^Pss:/ { print $2 }' "/proc/$p/smaps_rollup" 2> /dev/null || echo 0)))
        done
        group_mem=$(cat "/sys/fs/cgroup$cgroup/memory.current")
        group_cpu=$(awk '/^usage_usec/ { print $2 }' "/sys/fs/cgroup$cgroup/cpu.stat")
    fi
    metadata=$(pgrep -u "$TEST_USER" -x gvfsd-metadata | head -n 1)
    [ -z "$metadata" ] || metadata=$(awk '/^write_bytes:/ { print $2 }' "/proc/$metadata/io" 2> /dev/null)
    journal_append journal.txt "${UNITS[@]}"
    journal_append shell-journal.txt gnome-test-shell.service
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$now" "$((now - start))" "$pid" "$memory" "$cpu" \
        "$group_pss" "$group_mem" "$group_cpu" \
        "$(wc -l < "$OUT/journal.txt")" "$(wc -l < "$OUT/shell-journal.txt")" "$metadata" >> "$OUT/samples.tsv"
}

declare -A last=()
RUN_PROPS=(InvocationID ActiveState Result ExecMainStatus ExecMainStartTimestamp
    ExecMainStartTimestampMonotonic ExecMainExitTimestampMonotonic MemoryPeak MemorySwapPeak CPUUsageNSec)
# Appends a line to runs.tsv for each unit with a run that ended since the last check.
poll_runs() {
    local unit key value
    for unit in "${UNITS[@]}"; do
        local -A p=()
        while IFS='=' read -r key value; do p[$key]=$value; done \
            < <(user_show --timestamp=unix "${RUN_PROPS[@]/#/-p}" "$unit" 2> /dev/null)
        [ -n "${p[InvocationID]:-}" ] || continue
        [ "${p[InvocationID]}" != "${last[$unit]:-}" ] || continue
        case ${p[ActiveState]:-} in inactive | failed) ;; *) continue ;; esac
        last[$unit]=${p[InvocationID]}
        printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "${p[ExecMainStartTimestamp]#@}" "$unit" "${p[InvocationID]}" \
            "${p[Result]:-}" "${p[ExecMainStatus]:-}" \
            "$(awk -v a="${p[ExecMainStartTimestampMonotonic]:-0}" -v b="${p[ExecMainExitTimestampMonotonic]:-0}" \
                'BEGIN { printf "%.3f", (b - a) / 1e6 }')" \
            "${p[MemoryPeak]:-}" "${p[MemorySwapPeak]:-}" "${p[CPUUsageNSec]:-}" >> "$OUT/runs.tsv"
    done
}

start=$(date +%s)
end=$((start + seconds))
printf '# %s\n' "$(printf '%s\t' epoch elapsed_s shell_pid shell_pss_kb shell_pss_anon_kb shell_pss_shmem_kb \
    shell_rss_kb shell_cpu_s group_pss_kb group_mem_bytes group_cpu_us journal_lines shell_journal_lines \
    metadata_write_bytes)" \
    | sed 's/\t$//' > "$OUT/samples.tsv"
printf '# start_epoch\tunit\tinvocation\tresult\tstatus\tseconds\tpeak_bytes\tswap_peak_bytes\tcpu_ns\n' > "$OUT/runs.tsv"
printf '# %s\n' "$(printf '%s\t' epoch elapsed_s shell_pid collected gc_passes trim trim_detail \
    {pss,anon,shmem,rss}_before_kb {pss,anon,shmem,rss}_gc1_kb {pss,anon,shmem,rss}_gc3_kb \
    {pss,anon,shmem,rss}_trim_kb end_epoch)" | sed 's/\t$//' > "$OUT/gc.tsv"
: > "$OUT/journal.txt"
: > "$OUT/shell-journal.txt"
rm -f "$CURSOR_DIR"/gnome-test-soak-*.cursor
# The runs before the sampler started (the install) are in journal-user-end.txt, not in runs.tsv.
for unit in "${UNITS[@]}"; do last[$unit]=$(user_show -p InvocationID --value "$unit" 2> /dev/null); done
echo "$(date -Is) sampler start: $seconds s" >> "$OUT/sampler.log"
gc_interval=${GNOME_TEST_SOAK_GC_INTERVAL:-3600}
next=$start
next_gc=$((start + gc_interval))
probe_pid=0
while :; do
    now=$(date +%s)
    if [ "$now" -ge "$next" ]; then
        sample
        next=$((next + 60))
    fi
    if [ $probe_pid -gt 0 ] && ! kill -0 $probe_pid 2> /dev/null; then
        wait $probe_pid
        probe_pid=0
    fi
    if [ $probe_pid -eq 0 ] && [ "$(date +%s)" -ge $next_gc ] && [ $next_gc -le $((end - PROBE_MARGIN)) ]; then
        gc_probe &
        probe_pid=$!
        next_gc=$((next_gc + gc_interval))
    fi
    poll_runs
    [ "$now" -lt "$end" ] || break
    sleep 5
done
[ $probe_pid -eq 0 ] || wait $probe_pid
echo "$(date -Is) sampler end" >> "$OUT/sampler.log"
as_user_bare journalctl --user --no-pager -o short-iso-precise > "$OUT/journal-user-end.txt" 2>&1
if [ "${GNOME_TEST_SOAK_POWEROFF:-1}" = 1 ]; then
    systemctl poweroff --no-block
fi
