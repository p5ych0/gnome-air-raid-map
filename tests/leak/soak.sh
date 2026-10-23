#!/usr/bin/env bash
# The GNOME soak (spec 7.4, checks 4 and 5; plan Task 11). Starts two containers of
# the Fedora 44 image at the same time, each with a headless GNOME session at
# 1920x1080 under a real systemd user manager (tests/gnome/run-systemd.sh,
# scenario soak): "updater" has the program installed with install.sh, and its
# timer runs the updater every 30 s against NEPTUN; "control" has the same session
# without the updater. Both sample gnome-shell every 60 s (tests/gnome/soak-sampler.sh).
# Each container stops itself after <seconds>; this script only watches them.
# Usage: tests/leak/soak.sh <seconds>
#   Start the 24-hour soak in the background:
#     nohup tests/leak/soak.sh 86400 > tests/gnome/out/soak.log 2>&1 &
#   Evaluate (also while it runs):
#     gjs -m tests/leak/summarize.js --soak tests/gnome/out/fedora44-soak-updater tests/gnome/out/fedora44-soak-control
# Output: a "soak: <time> <elapsed> elapsed; ..." checkpoint line every
# GNOME_TEST_SOAK_CHECKPOINT seconds (default 600); at once (checked every 30 s):
# "soak: ... FAIL: ..." when a container stops early or gnome-shell is gone (the
# script then removes both containers and exits 1), and "soak: ... NOTE: updater
# run ..." for each updater run that did not succeed; "soak: ... done" at the end.
# Watch it with: tail -f tests/gnome/out/soak.log | grep --line-buffered 'soak:'
# Exit status 0 if both containers ran for the whole time.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
IMAGE=fedora44
ROLES=(updater control)
CHECKPOINT=${GNOME_TEST_SOAK_CHECKPOINT:-600}

[ $# -eq 1 ] && [[ $1 =~ ^[1-9][0-9]*$ ]] || { echo "usage: $0 <seconds>" >&2; exit 2; }
seconds=$1
out_of() {
    echo "$repo/tests/gnome/out/$IMAGE-soak-$1"
}

log() {
    echo "soak: $(date -Is) $*"
}

# Build the image once, so that the two starts below only use the layer cache.
declare -A container=() pid=()
mkdir -p "$repo/tests/gnome/out"
if ! podman build -t "localhost/gnome-air-raid-map-test:$IMAGE-systemd" - \
    < "$repo/tests/gnome/Containerfile.$IMAGE-systemd" > "$repo/tests/gnome/out/soak-build.log" 2>&1; then
    log "FAIL: the image does not build; see tests/gnome/out/soak-build.log"
    exit 1
fi
# Start both containers at the same time. run-systemd.sh writes the container name
# to <output>/container.
for role in "${ROLES[@]}"; do
    GNOME_TEST_DETACH=1 GNOME_TEST_OUT_NAME=$IMAGE-soak-$role GNOME_TEST_SOAK_ROLE=$role \
        GNOME_TEST_SOAK_SECONDS=$seconds "$repo/tests/gnome/run-systemd.sh" "$IMAGE" soak 1920x1080 \
        > "$repo/tests/gnome/out/soak-start-$role.log" 2>&1 &
    pid[$role]=$!
done
status=0
for role in "${ROLES[@]}"; do
    if wait "${pid[$role]}"; then
        container[$role]=$(cat "$(out_of "$role")/container")
        log "$role: started container ${container[$role]}; output $(out_of "$role")"
    else
        log "FAIL: $role: the container did not start; see tests/gnome/out/soak-start-$role.log"
        sed 's/^/  /' "$repo/tests/gnome/out/soak-start-$role.log"
        status=1
    fi
done
if [ $status -ne 0 ]; then
    for role in "${ROLES[@]}"; do
        [ -z "${container[$role]:-}" ] || podman rm -f -t 5 "${container[$role]}" > /dev/null 2>&1 || true
    done
    exit 1
fi

# The last line of a TSV file of the soak, or nothing.
last_line() {
    grep -v '^#' "$1" 2> /dev/null | tail -n 1
}

checkpoint() {
    local role line runs bad peak
    local elapsed=$(($(date +%s) - start))
    local text
    text=$(printf "%dh%02dm elapsed" $((elapsed / 3600)) $((elapsed / 60 % 60)))
    for role in "${ROLES[@]}"; do
        line=$(last_line "$(out_of "$role")/samples.tsv")
        text+="; $role: shell PSS $(cut -f4 <<< "$line") KB (anon $(cut -f5 <<< "$line")), CPU $(cut -f8 <<< "$line") s"
    done
    runs=$(grep -c $'\tgnome-air-raid-map.service\t' "$(out_of updater)/runs.tsv" 2> /dev/null || true)
    bad=$(awk -F '\t' '$2 == "gnome-air-raid-map.service" && ($4 != "success" || $5 != 0)' \
        "$(out_of updater)/runs.tsv" 2> /dev/null | wc -l)
    peak=$(awk -F '\t' '$2 == "gnome-air-raid-map.service" { p = $7 }
        END { if (p ~ /^[0-9]+$/) printf "%.1f MB", p / 1048576; else printf "%s", p }' \
        "$(out_of updater)/runs.tsv" 2> /dev/null)
    log "$text; updater runs $runs, not success $bad, last MemoryPeak $peak"
}

running() {
    podman container exists "$1" && [ "$(podman inspect -f '{{.State.Running}}' "$1" 2> /dev/null)" = true ]
}

finished() {
    grep -q 'sampler end' "$(out_of "$1")/sampler.log" 2> /dev/null
}

bad_runs() {
    awk -F '\t' '$2 == "gnome-air-raid-map.service" && ($4 != "success" || $5 != 0)' \
        "$(out_of updater)/runs.tsv" 2> /dev/null
}

start=$(date +%s)
next=$((start + CHECKPOINT))
reported=0 failed=0
declare -A done_role=()
# Each sampler stops its container after <seconds>. Wait for both, at most 10
# minutes longer. A container that stops before its sampler wrote "sampler end"
# is a failure.
printed=0
while [ ${#done_role[@]} -lt ${#ROLES[@]} ]; do
    sleep 30
    printed=0
    for role in "${ROLES[@]}"; do
        [ -z "${done_role[$role]:-}" ] || continue
        if running "${container[$role]}"; then
            if [ "$(cut -f3 <<< "$(last_line "$(out_of "$role")/samples.tsv")")" = 0 ]; then
                log "FAIL: $role: gnome-shell is not running (last sample)"
                failed=1
            fi
        elif finished "$role"; then
            done_role[$role]=1
            log "$role: the sampler ended; the container stopped"
        else
            log "FAIL: $role: the container stopped before the end of the soak"
            failed=1
        fi
    done
    if [ "$(bad_runs | wc -l)" -gt $reported ]; then
        bad_runs | tail -n +$((reported + 1)) | while IFS=$'\t' read -r at unit id result code rest; do
            log "NOTE: updater run at $(date -u -d "@$at" +%T) UTC: result $result, status $code"
        done
        reported=$(bad_runs | wc -l)
    fi
    if [ $failed -eq 1 ] || [ "$(date +%s)" -gt $((start + seconds + 600)) ]; then
        [ $failed -eq 1 ] || log "FAIL: the containers did not stop 10 minutes after the end"
        for role in "${ROLES[@]}"; do podman rm -f -t 5 "${container[$role]}" > /dev/null 2>&1 || true; done
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
log "done; evaluate with: gjs -m tests/leak/summarize.js --soak $(out_of updater) $(out_of control)"
