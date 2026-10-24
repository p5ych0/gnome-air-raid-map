#!/usr/bin/env bash
# Runs the updater many times against a local fixture server and records the
# peak memory and the CPU time of each run (spec 7.4, checks 1 to 3; plan Task 11).
# Usage: tests/leak/run-many.sh <runs> <display-override>
# Example: tests/leak/run-many.sh 1000 1920x1080@1 > out/leak-1080.txt
#
# The fixture server (tests/lib/fixture-server.js) serves the NEPTUN boundaries
# from tests/leak/.cache/ (run tests/leak/fetch-geometry.sh first) and the two
# alert files in turn, so every run draws a new picture. The updater gets
# AIR_RAID_MAP_API_BASE, AIR_RAID_MAP_DISPLAY=<display-override>,
# GSETTINGS_BACKEND=memory and its own temporary XDG folders. It never uses
# NEPTUN, Mutter or dconf.
#
# Output (stdout): one line for each run, "<run> <peak KB> <user s> <sys s> <exit>"
# (peak KB is the maximum RSS from /usr/bin/time). Lines that start with "#" are
# notes: du -sb and find | wc -l of each XDG folder after run 10 and after the last
# run, each file that changed size, the updater processes that are left, and the
# updater stderr. tests/leak/summarize.js reads this output.
#
# Files check (brief Step 3): du -sb and find | wc -l of each folder after run 10
# (run 11 if <runs> is odd: the alert payload alternates, so the check run has the
# same payload as the last run) and after the last run. The entry counts must be
# the same. The bytes must be the same, except in the runtime folder: the picture
# and state.json show the time of the run ("Оновлено HH:MM", the request times), so
# their size changes by a few bytes; the limit there is 1 %. A file that has another
# name or size after the last run is printed as a "# file changed" note. Example:
# the picture picture-<ms>.png. With GSETTINGS_BACKEND=memory each run starts with
# the default wallpaper settings, so each run moves the picture to a new name and
# deletes the old file (updater/run.js).
# Exit status: 0 if every run exits 0, the files check passes, and no updater
# process is left.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
cache="$here/.cache"
FILES=(oblasts.geojson raions.geojson threats.json alerts-a.json alerts-b.json)
FOLDERS=(runtime cache state data config)

usage() {
    echo "usage: $0 <runs> <display-override>   (example: $0 1000 1920x1080@1)" >&2
    exit 2
}
[ $# -eq 2 ] || usage
runs=$1 display=$2
[[ $runs =~ ^[1-9][0-9]*$ ]] || usage
for file in "${FILES[@]}"; do
    [ -f "$cache/$file" ] || { echo "$0: no $cache/$file: run tests/leak/fetch-geometry.sh first" >&2; exit 2; }
done
check_run=$((10 + runs % 2))

tmp=$(mktemp -d "${TMPDIR:-/tmp}/air-raid-map-leak.XXXXXX")
server=
cleanup() {
    [ -z "$server" ] || kill "$server" 2> /dev/null || true
    rm -rf "$tmp"
}
trap cleanup EXIT
for folder in "${FOLDERS[@]}"; do mkdir -m 700 "$tmp/$folder"; done

# A free port: try random ports until the fixture server listens on one.
listening() {
    (exec 5<> "/dev/tcp/127.0.0.1/$1") 2> /dev/null
}
for ((attempt = 0; attempt < 10; attempt++)); do
    port=$((20000 + RANDOM % 40000))
    listening "$port" && continue
    gjs -m "$repo/tests/lib/fixture-server.js" "$port" "$cache" >> "$tmp/fixture.log" 2>&1 &
    server=$!
    for ((i = 0; i < 40; i++)); do
        listening "$port" && break 2
        kill -0 "$server" 2> /dev/null || break
        sleep 0.25
    done
    kill "$server" 2> /dev/null || true
    server=
done
[ -n "$server" ] || { echo "$0: the fixture server did not start; see:" >&2; cat "$tmp/fixture.log" >&2; exit 1; }

export AIR_RAID_MAP_API_BASE=http://127.0.0.1:$port
export AIR_RAID_MAP_DISPLAY=$display
export GSETTINGS_BACKEND=memory
export XDG_RUNTIME_DIR=$tmp/runtime XDG_CACHE_HOME=$tmp/cache XDG_STATE_HOME=$tmp/state
export XDG_DATA_HOME=$tmp/data XDG_CONFIG_HOME=$tmp/config

# snapshot <run>: "# folder" lines (du -sb, find | wc -l) and a list of the files with their sizes.
snapshot() {
    local folder
    for folder in "${FOLDERS[@]}"; do
        echo "# folder after run $1: $folder $(du -sb "$tmp/$folder" | cut -f1) bytes," \
            "$(find "$tmp/$folder" | wc -l) entries"
    done > "$tmp/folders-$1"
    (cd "$tmp" && find "${FOLDERS[@]}" -printf '%p %s\n' | LC_ALL=C sort) > "$tmp/files-$1"
}

echo "# $(date -Is) $(gjs --version), display $display, $runs runs, fixture $AIR_RAID_MAP_API_BASE"
failed=0
for ((n = 1; n <= runs; n++)); do
    code=0
    /usr/bin/time -f '%M %U %S' -o "$tmp/time" gjs -m "$repo/updater/main.js" 2>> "$tmp/stderr" || code=$?
    # After a non-zero exit, /usr/bin/time writes a "Command exited" line first.
    echo "$n $(tail -n 1 "$tmp/time") $code"
    [ $code -eq 0 ] || failed=$((failed + 1))
    [ $n -ne $check_run ] || snapshot $n
done
snapshot last

status=0
[ $failed -eq 0 ] || status=1
if [ -f "$tmp/files-$check_run" ]; then
    cat "$tmp/folders-$check_run"
    sed "s/after run last/after run $runs/" "$tmp/folders-last"
    files_ok=1
    for folder in "${FOLDERS[@]}"; do
        read -r bytes_check entries_check < <(sed -n "s/^# folder after run [0-9]*: $folder \([0-9]*\) bytes, \([0-9]*\) entries$/\1 \2/p" "$tmp/folders-$check_run")
        read -r bytes_last entries_last < <(sed -n "s/^# folder after run last: $folder \([0-9]*\) bytes, \([0-9]*\) entries$/\1 \2/p" "$tmp/folders-last")
        [ "$entries_check" = "$entries_last" ] || files_ok=0
        if [ "$folder" = runtime ]; then
            awk -v a="$bytes_check" -v b="$bytes_last" 'BEGIN { exit !(a > 0 && (a > b ? a - b : b - a) < a / 100) }' || files_ok=0
        else
            [ "$bytes_check" = "$bytes_last" ] || files_ok=0
        fi
    done
    # Each changed file: "<path> <size at the check run> <size after the last run>".
    LC_ALL=C join -a 1 -a 2 -e none -o 0,1.2,2.2 "$tmp/files-$check_run" "$tmp/files-last" |
        awk '$2 != $3 { print "# file changed: " $1 " " $2 " -> " $3 " bytes" }'
    if [ $files_ok -eq 1 ]; then
        echo "# files: PASS: the same entry counts and bytes after run $check_run and after run $runs (runtime folder: bytes within 1 %)"
    else
        echo "# files: FAIL: the entry counts or bytes after run $runs differ from run $check_run"
        status=1
    fi
else
    sed "s/after run last/after run $runs/" "$tmp/folders-last"
    echo "# files: no check (fewer than $check_run runs)"
fi
(cd "$tmp" && find "${FOLDERS[@]}" -type f -printf "# file after run $runs: %p %s bytes\n" | LC_ALL=C sort)
# Each run is a new process; none may stay.
left=$(pgrep -f -a "$repo/updater/main.js" || true)
if [ -z "$left" ]; then
    echo "# processes: no updater process is left"
else
    echo "$left" | sed 's/^/# process left: /'
    status=1
fi
echo "# updater stderr: $(wc -l < "$tmp/stderr") lines"
sort "$tmp/stderr" | uniq -c | sort -rn | head -n 5 | sed 's/^/# stderr: /'
echo "# runs that did not exit 0: $failed"
exit $status
