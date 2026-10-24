#!/usr/bin/env bash
# Runs one scenario of tests/gnome/scenarios in a headless GNOME Shell in a
# disposable Podman container. Nothing is installed on the host.
# Usage: tests/gnome/run.sh <fedora44|ubuntu2404> <scenario> [virtual-monitor ...]
# Example: tests/gnome/run.sh fedora44 reload 1920x1080
# Output: the scenario prints to stdout; files go to tests/gnome/out/<image>-<scenario>/
# (run.sh empties that folder first).
# Variables named GNOME_TEST_* go into the container (example: GNOME_TEST_UPDATES).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

usage() {
    echo "usage: $0 <fedora44|ubuntu2404> <scenario> [virtual-monitor ...]" >&2
    exit 2
}
[ $# -ge 2 ] || usage
image=$1 scenario=$2
shift 2
case $image in fedora44 | ubuntu2404) ;; *) usage ;; esac
[ -f "$here/scenarios/$scenario.sh" ] || { echo "no scenario: $here/scenarios/$scenario.sh" >&2; exit 2; }

out="$here/out/$image-$scenario"
rm -rf "$out"
mkdir -p "$out"

# The layer cache makes this fast when the Containerfile did not change.
# The Containerfile comes on stdin, so the build has no context directory.
tag="localhost/gnome-air-raid-map-test:$image"
if ! podman build -t "$tag" - < "$here/Containerfile.$image" > "$out/build.log" 2>&1; then
    tail -n 30 "$out/build.log" >&2
    exit 1
fi

# --privileged: GNOME 50 loads images through glycin, and the bwrap sandbox of
# glycin fails without it. Rootless --privileged has only the rights of the user.
# It also turns off SELinux separation, so the mounts need no :Z relabel.
# XDG_RUNTIME_DIR must exist with mode 700 before dbus-run-session: without it,
# dconf and the Shell use different change files and the Shell never sees new
# settings. The output of dbus-run-session and of the session bus goes to
# session.log; session.sh gives the scenario the real stdout (fd 4) and stderr (fd 3).
exec podman run --rm --privileged \
    --env 'GNOME_TEST_*' -e XDG_RUNTIME_DIR=/tmp/xdg -e "GNOME_TEST_IMAGE=$image" \
    -v "$repo:/repo:ro" -v "$out:/out" \
    "$tag" \
    bash -c 'mkdir -m 700 -p /tmp/xdg && exec 3>&2 4>&1 >>/out/session.log 2>&1 &&
             exec dbus-run-session -- /repo/tests/gnome/session.sh "$@"' \
    session "$scenario" "$@"
