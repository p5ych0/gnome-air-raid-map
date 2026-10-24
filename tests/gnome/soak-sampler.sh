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
#                time): a full garbage collection in gnome-shell, through
#                org.gnome.Shell.Eval (the Shell runs with --unsafe-mode). One line:
#                PSS, anonymous PSS, shmem PSS and RSS before the collection and 30 s
#                after it, and "collected": the proof that the collection ran. Before
#                it, an Eval creates an object that only a WeakRef holds; a second
#                Eval runs imports.system.gc() and then checks that the WeakRef is
#                empty (true). Without a collection, the object stays (false). The
#                two Evals are two jobs, so the WeakRef does not keep the object.
#                The sampler does not wait for the 30 s: it samples and polls as usual.
#   journal.txt        the journalctl --user lines of the two units.
#   shell-journal.txt  the journalctl --user lines of gnome-test-shell.service.
#   journal-user-end.txt  the whole user journal, at the end.
# The control container runs the same sampler: it has no updater, so its runs.tsv
# and journal.txt stay empty, and both containers have the same sampler load.
set -u
OUT=/out
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
    local file=$1 cursor=/var/tmp/gnome-test-soak-$(basename "$1").cursor
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

# The first half of a GC probe: the sample before, the proof object, the collection.
gc_start() {
    gc_pid=$(shell_pid)
    gc_epoch=$(date +%s)
    gc_before=$(memory "$gc_pid")
    shell_eval 'globalThis.__soakProbe = new WeakRef({}); true' > /dev/null
    gc_collected=$(shell_eval 'imports.system.gc(); globalThis.__soakProbe.deref() === undefined')
    gc_due=$((gc_epoch + 30))
}

# The second half, 30 s later: the sample after, and one line in gc.tsv.
gc_end() {
    local pid
    pid=$(shell_pid)
    [ "$pid" = "$gc_pid" ] || gc_collected="shell restarted"
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$gc_epoch" "$((gc_epoch - start))" "$pid" "$gc_collected" \
        "$gc_before" "$(memory "$pid")" >> "$OUT/gc.tsv"
    gc_due=0
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
printf '# %s\n' "$(printf '%s\t' epoch elapsed_s shell_pid collected pss_before_kb anon_before_kb shmem_before_kb \
    rss_before_kb pss_after_kb anon_after_kb shmem_after_kb rss_after_kb)" | sed 's/\t$//' > "$OUT/gc.tsv"
: > "$OUT/journal.txt"
: > "$OUT/shell-journal.txt"
rm -f /var/tmp/gnome-test-soak-*.cursor
# The runs before the sampler started (the install) are in journal-user-end.txt, not in runs.tsv.
for unit in "${UNITS[@]}"; do last[$unit]=$(user_show -p InvocationID --value "$unit" 2> /dev/null); done
echo "$(date -Is) sampler start: $seconds s" >> "$OUT/sampler.log"
gc_interval=${GNOME_TEST_SOAK_GC_INTERVAL:-3600}
next=$start
next_gc=$((start + gc_interval))
gc_due=0
while :; do
    now=$(date +%s)
    if [ "$now" -ge "$next" ]; then
        sample
        next=$((next + 60))
    fi
    if [ $gc_due -gt 0 ] && [ "$(date +%s)" -ge $gc_due ]; then
        gc_end
    fi
    # The last probe must end 30 s before the end of the sampler.
    if [ $gc_due -eq 0 ] && [ "$(date +%s)" -ge $next_gc ] && [ $next_gc -le $((end - 35)) ]; then
        gc_start
        next_gc=$((next_gc + gc_interval))
    fi
    poll_runs
    [ "$now" -lt "$end" ] || break
    sleep 5
done
echo "$(date -Is) sampler end" >> "$OUT/sampler.log"
as_user_bare journalctl --user --no-pager -o short-iso-precise > "$OUT/journal-user-end.txt" 2>&1
if [ "${GNOME_TEST_SOAK_POWEROFF:-1}" = 1 ]; then
    systemctl poweroff --no-block
fi
