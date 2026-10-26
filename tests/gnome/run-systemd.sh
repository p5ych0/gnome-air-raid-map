#!/usr/bin/env bash
# Runs one scenario of tests/gnome/scenarios in a disposable Podman container where
# systemd is PID 1 (plan Task 11). The test user "tester" has a real systemd user
# manager, a session D-Bus, and a headless GNOME Shell that runs as a user service
# (session-units/). The scenarios of run.sh have no systemd; these scenarios test
# the real timer, the units and install.sh. Nothing is installed on the host.
# Usage: tests/gnome/run-systemd.sh <fedora44|ubuntu2404> <scenario> [virtual-monitor ...]
# Example: tests/gnome/run-systemd.sh fedora44 systemd 1920x1080
# Output: the scenario prints to stdout; files go to tests/gnome/out/<name>/, with
# <name> = <image>-<scenario> or GNOME_TEST_OUT_NAME (run-systemd.sh empties it first;
# GNOME_TEST_OUT_NAME can have a slash: soak-<time>/<role>).
# Variables named GNOME_TEST_* go into the container. GNOME_TEST_DETACH=1 leaves the
# container running after the scenario and prints its name (the soak uses this; the
# container then removes itself when systemd in it stops).
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

name=${GNOME_TEST_OUT_NAME-$image-$scenario}
# The name must stay inside tests/gnome/out: rm -rf empties it. An inner slash is allowed
# (the soak uses soak-<time>/<role>). Not allowed: an empty name, a name that starts or
# ends with a slash, an empty or "." part, and "..".
case $name in
    '' | /* | */ | *//* | *..* | . | ./* | */. | */./*)
        echo "$0: bad GNOME_TEST_OUT_NAME '$name': use a relative name with no '..', no empty part and no '.' part" >&2
        exit 2 ;;
esac
out="$here/out/$name"
rm -rf "$out"
mkdir -p "$out"

# The Containerfile comes on stdin, so the build has no context directory.
tag="localhost/gnome-air-raid-map-test:$image-systemd"
if ! podman build -t "$tag" - < "$here/Containerfile.$image-systemd" > "$out/build.log" 2>&1; then
    tail -n 30 "$out/build.log" >&2
    exit 1
fi

# --systemd=always: systemd is PID 1, and Podman gives it the mounts and the
# cgroup it needs. --privileged: as in run.sh (glycin needs it). The session units
# are mounted into /etc/systemd/user before the user manager starts.
# A container name cannot have a slash (the soak uses <name> = soak-<time>/<role>).
container="gnome-air-raid-map-${name//\//-}-$$"
remove() {
    podman rm -f -t 5 "$container" > /dev/null 2>&1 || true
}
podman run -d --rm --name "$container" --systemd=always --privileged \
    --env 'GNOME_TEST_*' -e "GNOME_TEST_IMAGE=$image" \
    -v "$repo:/repo:ro" -v "$out:/out" \
    -v "$here/session-units/gnome-test-session.target:/etc/systemd/user/gnome-test-session.target:ro" \
    -v "$here/session-units/gnome-test-shell.service:/etc/systemd/user/gnome-test-shell.service:ro" \
    "$tag" /sbin/init > /dev/null
trap remove EXIT

# No podman exec before systemd has moved itself into init.scope: an exec process
# joins the cgroup of PID 1. Before the move, that is the root cgroup of the
# container, and while a process is in it, PID 1 cannot enable the cpu and memory
# controllers for its children (the cgroup v2 rule "no internal processes"). The
# user manager then starts without them, and MemoryMax= does not apply. So wait on
# the host side, in /proc/<pid>/cgroup of PID 1 of the container.
pid=$(podman inspect -f '{{.State.Pid}}' "$container")
for ((i = 0; i < 300; i++)); do
    [[ $(cat "/proc/$pid/cgroup" 2> /dev/null) == */init.scope ]] && break
    sleep 0.1
done
[[ $(cat "/proc/$pid/cgroup" 2> /dev/null) == */init.scope ]] || {
    echo "systemd in the container did not move into init.scope" >&2
    exit 1
}
# Boot ends with "running" or "degraded" (some kernel file systems cannot mount in
# a rootless container). Right after the start, systemctl cannot connect yet.
for ((i = 0; i < 60; i++)); do
    state=$(podman exec "$container" systemctl is-system-running --wait 2> /dev/null || true)
    case $state in running | degraded) break ;; esac
    sleep 1
done
echo "# container $container: system $state" >&2
podman exec "$container" systemctl --failed --plain --no-legend > "$out/failed-system-units.txt" 2>&1 || true

status=0
podman exec "$container" /repo/tests/gnome/session-systemd.sh "$scenario" "$@" || status=$?
if [ "${GNOME_TEST_DETACH:-}" = 1 ] && [ $status -eq 0 ]; then
    trap - EXIT
    echo "$container" > "$out/container"
fi
exit $status
