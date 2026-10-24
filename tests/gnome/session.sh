#!/bin/bash
# Runs inside the container under dbus-run-session (tests/gnome/run.sh starts it).
# Starts a headless GNOME Shell, then runs scenarios/<scenario>.sh in a subshell.
# The scenario can use these functions:
#   shell_eval <js>                 runs <js> in the Shell; prints the JSON result
#   screenshot <path>               saves a PNG of the whole screen
#   set_wallpaper <uri> <options>   sets picture-uri, picture-uri-dark, picture-options
#   wait_shell <seconds> <js>       waits until <js> is true in the Shell
#   stop_shell, start_shell <virtual-monitor ...>
#                                   restart the Shell with other virtual monitors
# Usage: session.sh <scenario> [virtual-monitor ...]   (default monitor: 1920x1080)
set -u
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
OUT=/out
SCENARIO=$1
shift
MONITORS=("$@")
[ ${#MONITORS[@]} -gt 0 ] || MONITORS=(1920x1080)

# run.sh sends the output of dbus-run-session to a log and keeps the real
# stdout on fd 4 and the real stderr on fd 3.
if { true >&3 && true >&4; } 2> /dev/null; then exec 1>&4 2>&3 3>&- 4>&-; fi

shell_eval() {
    local reply
    reply=$(gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1") || return 1
    case $reply in
        "(true, '"*"')") reply=${reply#"(true, '"}; printf '%s\n' "${reply%"')"}" ;;
        *) printf 'shell_eval failed: %s\n' "$reply" >&2; return 1 ;;
    esac
}

screenshot() {
    local reply
    reply=$(gdbus call --session --dest org.gnome.Shell.Screenshot \
        --object-path /org/gnome/Shell/Screenshot \
        --method org.gnome.Shell.Screenshot.Screenshot false false "$1") || return 1
    case $reply in
        "(true, "*) ;;
        *) printf 'screenshot failed: %s\n' "$reply" >&2; return 1 ;;
    esac
}

# One change for the three keys: when picture-uri and picture-uri-dark change in
# two writes, the Shell starts to load the first picture and then destroys it
# ("this._fileWatches is null" in shell.log).
set_wallpaper() {
    gjs -c '
        const Gio = imports.gi.Gio;
        const settings = new Gio.Settings({schema_id: "org.gnome.desktop.background"});
        settings.delay();
        settings.set_string("picture-options", ARGV[1]);
        settings.set_string("picture-uri", ARGV[0]);
        settings.set_string("picture-uri-dark", ARGV[0]);
        settings.apply();
        Gio.Settings.sync();' "$1" "$2"
}

# Waits up to $1 seconds until the Shell evaluates $2 to true.
wait_shell() {
    local i
    for ((i = 0; i < $1 * 4; i++)); do
        [ "$(shell_eval "$2" 2> /dev/null)" = true ] && return 0
        sleep 0.25
    done
    printf 'timeout: %s\n' "$2" >&2
    return 1
}

shell_running() {
    [ "$(gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
        --method org.freedesktop.DBus.NameHasOwner org.gnome.Shell 2> /dev/null)" = "(true,)" ]
}

# wait works only in the shell that started the Shell, not in the subshell of a
# scenario, so also wait until the Shell leaves the bus (10 s at most).
stop_shell() {
    [ -n "${SHELL_PID:-}" ] || return 0
    kill "$SHELL_PID" 2> /dev/null
    wait "$SHELL_PID" 2> /dev/null
    local i
    for ((i = 0; i < 40; i++)); do
        shell_running || break
        sleep 0.25
    done
    SHELL_PID=
}
trap stop_shell EXIT

# Starts GNOME Shell with one --virtual-monitor for each argument and waits
# until it shows the desktop. Returns 1 on a failure. The Shell log goes to
# $OUT/shell.log; a restart adds to it.
start_shell() {
    local args=("${SHELL_ARGS[@]}") m i
    for m in "$@"; do args+=(--virtual-monitor "$m"); done
    gnome-shell "${args[@]}" >> "$OUT/shell.log" 2>&1 &
    SHELL_PID=$!
    for ((i = 0; i < 60; i++)); do
        shell_running && break
        kill -0 "$SHELL_PID" 2> /dev/null || { echo "gnome-shell exited; see $OUT/shell.log" >&2; return 1; }
        sleep 1
    done
    [ $i -lt 60 ] || { echo "gnome-shell did not take the org.gnome.Shell name" >&2; return 1; }
    wait_shell 30 '!Main.layoutManager._startingUp' || return 1
    # GNOME opens the overview at startup; hide it so that the desktop background shows.
    shell_eval 'Main.overview.hide(); true' > /dev/null || return 1
    wait_shell 10 '!Main.overview.visible && !Main.overview.animationInProgress' || return 1
}

export XDG_SESSION_TYPE=wayland
# GNOME Shell needs a system bus: the login and time-limit managers connect to it.
mkdir -p /run/dbus && dbus-daemon --system --fork
# No logind in the container: without /run/systemd/seats the Shell uses its dummy login manager.
rm -rf /run/systemd/seats

SHELL_ARGS=(--headless --wayland --no-x11 --unsafe-mode)
export XDG_CURRENT_DESKTOP=GNOME
if [ "${GNOME_TEST_IMAGE:-}" = ubuntu2404 ]; then
    # The ubuntu mode shows the dock. The [...:ubuntu] schema overrides apply
    # only with "ubuntu" in XDG_CURRENT_DESKTOP; they put the dock on the left
    # at full height, as on a real Ubuntu desktop (without them it is at the bottom).
    SHELL_ARGS+=(--mode=ubuntu)
    export XDG_CURRENT_DESKTOP=ubuntu:GNOME
fi
# The session runs as root, so GNOME 46 shows a "Logged in as a privileged
# user" banner over the screen. Banners are off; messages stay in the list.
gsettings set org.gnome.desktop.notifications show-banners false
start_shell "${MONITORS[@]}" || exit 1
# Without a GPU the Shell turns animations off (no fade between wallpapers).
animations=$(shell_eval 'imports.gi.St.Settings.get().enable_animations' 2> /dev/null)
echo "# $(gnome-shell --version), $(gjs --version), monitors ${MONITORS[*]}, animations ${animations:-unknown}" >&2

(. "$HERE/scenarios/$SCENARIO.sh")
status=$?
# A screenshot can still be in progress after the call returns; wait before the Shell stops.
sleep 3
exit $status
