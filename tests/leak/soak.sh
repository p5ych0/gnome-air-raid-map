#!/usr/bin/env bash
# The GNOME soak (spec 7.4, checks 4 and 5; plan Task 11). Starts three containers of
# the Fedora 44 image at the same time, each with a headless GNOME session at
# 1920x1080 under a real systemd user manager (tests/gnome/run-systemd.sh, scenario
# soak), with the roles:
#   updater            install.sh; the real timer runs the updater every 30 s against NEPTUN
#   updater-unchanged  the same, with AIR_RAID_MAP_LABEL_MODE=unchanged (a drop-in)
#   control            the same session without the updater
# Each samples gnome-shell every 60 s, and makes a full garbage collection in
# gnome-shell every GNOME_TEST_SOAK_GC_INTERVAL s (default 3600) with a sample 30 s
# after it (tests/gnome/soak-sampler.sh). Each container stops itself after <seconds>;
# this script only watches them.
#
# Usage: tests/leak/soak.sh <seconds>
#   Start the 24-hour soak in the background, with no host suspend:
#     nohup systemd-inhibit --what=sleep:idle --who=gnome-air-raid-map-soak \
#         --why='gnome-air-raid-map soak' tests/leak/soak.sh 86400 >> tests/gnome/out/soak-nohup.log 2>&1 &
#   Watch:    tail -n +1 -F tests/gnome/out/soak-latest/soak.log | grep --line-buffered 'soak:'
#   Evaluate: gjs -m tests/leak/summarize.js --soak --expect 86400 tests/gnome/out/soak-latest
#
# Output folder: tests/gnome/out/soak-<YYYYmmdd-HHMMSS>/ with one folder for each
# role and soak.log; tests/gnome/out/soak-latest is a link to it. A new run never
# changes the folder of an earlier run. The script refuses to start while the
# containers of another soak run.
# soak.log: a "soak: <time> <elapsed> elapsed; ..." checkpoint line every
# GNOME_TEST_SOAK_CHECKPOINT s (default 600); at once (checked every
# GNOME_TEST_SOAK_POLL s, default 30): "soak: ... FAIL: ..." when a container stops
# early, gnome-shell is gone, or the last sample of a running sampler is older than
# 150 s (the script then removes all containers and exits 1), and
# "soak: ... NOTE: ..." for each updater run that did not succeed; "soak: ... done"
# at the end. If the script stops early (a signal, an error), it writes "FAIL:
# soak.sh stopped" and the file <folder>/aborted, and removes the containers. After
# a SIGKILL, it cannot: the containers then still stop themselves after <seconds>.
# Exit status 0 if all containers ran for the whole time.
set -u -o pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
IMAGE=fedora44
ROLES=(updater updater-unchanged control)
UPDATER_ROLES=(updater updater-unchanged)
CHECKPOINT=${GNOME_TEST_SOAK_CHECKPOINT:-600}
POLL=${GNOME_TEST_SOAK_POLL:-30}
# The sampler writes a sample every 60 s. summarize.js fails a gap above 150 s
# (MAX_SAMPLE_GAP_S), so the watcher reports it at once.
MAX_SAMPLE_AGE=150
PREFIX=gnome-air-raid-map-soak-

[ $# -eq 1 ] && [[ $1 =~ ^[1-9][0-9]*$ ]] || { echo "usage: $0 <seconds>" >&2; exit 2; }
seconds=$1

log() {
    echo "soak: $(date -Is) $*"
}

# Another soak still runs: its containers have the prefix.
if podman ps --format '{{.Names}}' | grep -q "^$PREFIX"; then
    log "FAIL: the containers of another soak run; stop them first:"
    podman ps --format '{{.Names}}' | grep "^$PREFIX" | sed 's/^/  /'
    exit 1
fi
run=soak-$(date +%Y%m%d-%H%M%S)
dir=$repo/tests/gnome/out/$run
mkdir -p "$repo/tests/gnome/out"
mkdir "$dir" || { log "FAIL: $dir exists"; exit 1; }
ln -sfn "$run" "$repo/tests/gnome/out/soak-latest"
exec > >(tee -a "$dir/soak.log") 2>&1

out_of() {
    echo "$dir/$1"
}

declare -A container=() pid=()
finished=0
# One podman rm for all containers: it stops them in parallel.
remove_all() {
    local role names=()
    for role in "${ROLES[@]}"; do
        [ -z "${container[$role]:-}" ] || names+=("${container[$role]}")
    done
    [ ${#names[@]} -eq 0 ] || podman rm -f -t 5 "${names[@]}" > /dev/null 2>&1
}
on_exit() {
    local code=$?
    [ $finished -eq 1 ] && return
    log "FAIL: soak.sh stopped before the end (exit status $code); removing the containers"
    echo "soak.sh stopped at $(date -Is), exit status $code" >> "$dir/aborted"
    remove_all
    log "the containers are removed"
}
trap on_exit EXIT
trap 'log "FAIL: soak.sh got SIGTERM"; exit 143' TERM
trap 'log "FAIL: soak.sh got SIGINT"; exit 130' INT
trap 'log "FAIL: soak.sh got SIGHUP"; exit 129' HUP

log "start: $seconds s, roles ${ROLES[*]}, output $dir"
# Build the image once, so that the starts below only use the layer cache.
if ! podman build -t "localhost/gnome-air-raid-map-test:$IMAGE-systemd" - \
    < "$repo/tests/gnome/Containerfile.$IMAGE-systemd" > "$dir/build.log" 2>&1; then
    log "FAIL: the image does not build; see $dir/build.log"
    exit 1
fi
# Start all containers at the same time. run-systemd.sh writes the container name
# to <output>/container.
for role in "${ROLES[@]}"; do
    GNOME_TEST_DETACH=1 GNOME_TEST_OUT_NAME=$run/$role GNOME_TEST_SOAK_ROLE=$role \
        GNOME_TEST_SOAK_SECONDS=$seconds "$repo/tests/gnome/run-systemd.sh" "$IMAGE" soak 1920x1080 \
        > "$dir/start-$role.log" 2>&1 &
    pid[$role]=$!
done
status=0
for role in "${ROLES[@]}"; do
    if wait "${pid[$role]}" && [ -s "$(out_of "$role")/container" ]; then
        container[$role]=$(cat "$(out_of "$role")/container")
        log "$role: started container ${container[$role]}"
    else
        log "FAIL: $role: the container did not start; see $dir/start-$role.log"
        sed 's/^/  /' "$dir/start-$role.log"
        status=1
    fi
done
[ $status -eq 0 ] || exit 1

# The last line of a TSV file of the soak, or nothing.
last_line() {
    grep -v '^#' "$1" 2> /dev/null | tail -n 1 || true
}

bad_runs() {
    awk -F '\t' '$2 == "gnome-air-raid-map.service" && ($4 != "success" || $5 != 0)' \
        "$(out_of "$1")/runs.tsv" 2> /dev/null || true
}

checkpoint() {
    local role line runs bad peak elapsed=$(($(date +%s) - start)) text
    text=$(printf "%dh%02dm elapsed" $((elapsed / 3600)) $((elapsed / 60 % 60)))
    for role in "${ROLES[@]}"; do
        line=$(last_line "$(out_of "$role")/samples.tsv")
        text+="; $role: shell PSS $(cut -f4 <<< "$line") KB (anon $(cut -f5 <<< "$line")), CPU $(cut -f8 <<< "$line") s"
    done
    for role in "${UPDATER_ROLES[@]}"; do
        runs=$(grep -c $'\tgnome-air-raid-map.service\t' "$(out_of "$role")/runs.tsv" 2> /dev/null || true)
        bad=$(bad_runs "$role" | wc -l)
        peak=$(awk -F '\t' '$2 == "gnome-air-raid-map.service" { p = $7 }
            END { if (p ~ /^[0-9]+$/) printf "%.1f MB", p / 1048576; else printf "%s", p }' \
            "$(out_of "$role")/runs.tsv" 2> /dev/null || true)
        text+="; $role runs ${runs:-0}, not success $bad, last MemoryPeak ${peak:-none}"
    done
    log "$text"
}

running() {
    podman container exists "$1" && [ "$(podman inspect -f '{{.State.Running}}' "$1" 2> /dev/null)" = true ]
}

sampler_ended() {
    grep -q 'sampler end' "$(out_of "$1")/sampler.log" 2> /dev/null
}

start=$(date +%s)
next=$((start + CHECKPOINT))
failed=0 printed=0
declare -A done_role=() reported=()
# Each sampler stops its container after <seconds>. Wait for all, at most 10 minutes
# longer. A container that stops before its sampler wrote "sampler end" is a failure.
while [ ${#done_role[@]} -lt ${#ROLES[@]} ]; do
    # In the background, so that a signal stops the wait at once: bash runs a trap
    # only after the foreground command ends.
    sleep "$POLL" &
    wait $!
    printed=0
    for role in "${ROLES[@]}"; do
        [ -z "${done_role[$role]:-}" ] || continue
        if running "${container[$role]}"; then
            line=$(last_line "$(out_of "$role")/samples.tsv")
            if [ "$(cut -f3 <<< "$line")" = 0 ]; then
                log "FAIL: $role: gnome-shell is not running (last sample)"
                failed=1
            fi
            # A sampler that stops writes no new samples, but its container keeps running:
            # only the sampler stops it. After "sampler end" no sample comes while the
            # container stops, and that is not a failure.
            epoch=$(cut -f1 <<< "$line")
            if [[ $epoch =~ ^[0-9]+$ ]] && ! sampler_ended "$role"; then
                age=$(($(date +%s) - epoch))
                if [ $age -gt $MAX_SAMPLE_AGE ]; then
                    log "FAIL: $role: the sampler stopped (the last sample is $age s old, more than $MAX_SAMPLE_AGE s)"
                    failed=1
                fi
            fi
        elif sampler_ended "$role"; then
            done_role[$role]=1
            log "$role: the sampler ended; the container stopped"
        else
            log "FAIL: $role: the container stopped before the end of the soak"
            failed=1
        fi
    done
    for role in "${UPDATER_ROLES[@]}"; do
        count=$(bad_runs "$role" | wc -l)
        if [ "$count" -gt "${reported[$role]:-0}" ]; then
            bad_runs "$role" | tail -n +$((${reported[$role]:-0} + 1)) |
                while IFS=$'\t' read -r at unit id result code rest; do
                    log "NOTE: $role: updater run at $(date -u -d "@$at" +%T) UTC: result $result, status $code"
                done
            reported[$role]=$count
        fi
    done
    if [ $failed -eq 1 ] || [ "$(date +%s)" -gt $((start + seconds + 600)) ]; then
        [ $failed -eq 1 ] || log "FAIL: the containers did not stop 10 minutes after the end"
        checkpoint
        exit 1
    fi
    if [ "$(date +%s)" -ge "$next" ]; then
        checkpoint
        printed=1
        next=$((next + CHECKPOINT))
    fi
done
[ $printed -eq 1 ] || checkpoint
finished=1
log "done; evaluate with: gjs -m tests/leak/summarize.js --soak --expect $seconds $dir"
