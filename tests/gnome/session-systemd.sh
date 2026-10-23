#!/bin/bash
# Runs as root inside a container where systemd is PID 1 (tests/gnome/run-systemd.sh
# starts it with podman exec). The test user "tester" has linger, so systemd starts
# its user manager (user@<uid>.service) and its session D-Bus at boot. This script
# starts the headless GNOME session of tester under that user manager
# (session-units/: gnome-test-session.target starts graphical-session.target after
# gnome-test-shell.service is ready), then runs scenarios/<scenario>.sh in a subshell.
# The scenario can use these functions and variables:
#   as_user <command ...>          runs a command as tester, with the environment of
#                                  the user manager (systemctl --user show-environment)
#   user_systemctl <args ...>      systemctl --user of tester
#   user_journal <args ...>        journalctl --user of tester
#   shell_eval <js>                runs <js> in the Shell; prints the JSON result
#   screenshot <path>              saves a PNG of the whole screen
#   wait_shell <seconds> <js>      waits until <js> is true in the Shell
#   start_session, stop_session    log in and log out: start or stop gnome-test-session.target
#   TEST_USER, TEST_UID, TEST_HOME, TEST_RUNTIME (the XDG_RUNTIME_DIR of tester), OUT
# Usage: session-systemd.sh <scenario> [virtual-monitor ...]   (default monitor: 1920x1080)
set -u
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
OUT=/out
SCENARIO=$1
shift
MONITORS=("$@")
[ ${#MONITORS[@]} -gt 0 ] || MONITORS=(1920x1080)

TEST_USER=tester
TEST_UID=$(id -u "$TEST_USER") || exit 1
TEST_HOME=$(getent passwd "$TEST_USER" | cut -d: -f6)
TEST_RUNTIME=/run/user/$TEST_UID
USER_ENV=()

# Before the user manager answers: only the two variables that systemctl --user needs.
as_user_bare() {
    runuser -u "$TEST_USER" -- env -i HOME="$TEST_HOME" PATH=/usr/local/bin:/usr/bin:/bin \
        XDG_RUNTIME_DIR="$TEST_RUNTIME" DBUS_SESSION_BUS_ADDRESS="unix:path=$TEST_RUNTIME/bus" "$@"
}

# A terminal in a GNOME session gets the environment of the user manager, as the
# services do. Each run reads it again: a scenario can change it with set-environment.
as_user() {
    mapfile -t USER_ENV < <(as_user_bare systemctl --user show-environment)
    runuser -u "$TEST_USER" -- env -i "${USER_ENV[@]}" "$@"
}

user_systemctl() {
    as_user_bare systemctl --user "$@"
}

user_journal() {
    as_user_bare journalctl --user --no-pager "$@"
}

shell_eval() {
    local reply
    reply=$(as_user_bare gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1") || return 1
    case $reply in
        "(true, '"*"')") reply=${reply#"(true, '"}; printf '%s\n' "${reply%"')"}" ;;
        *) printf 'shell_eval failed: %s\n' "$reply" >&2; return 1 ;;
    esac
}

# The Shell runs as tester and cannot write to /out: it writes to /tmp first.
screenshot() {
    local reply temporary=/tmp/gnome-test-screenshot.png
    rm -f "$temporary"
    reply=$(as_user_bare gdbus call --session --dest org.gnome.Shell.Screenshot \
        --object-path /org/gnome/Shell/Screenshot \
        --method org.gnome.Shell.Screenshot.Screenshot false false "$temporary") || return 1
    case $reply in
        "(true, "*) ;;
        *) printf 'screenshot failed: %s\n' "$reply" >&2; return 1 ;;
    esac
    # The Shell can still write the file after the call returns.
    sleep 1
    cp "$temporary" "$1"
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

# Log in: start the session target. systemctl returns when the Shell has sent
# READY=1 and graphical-session.target is active. GNOME opens the overview at
# startup; hide it so that the desktop background shows.
start_session() {
    user_systemctl start gnome-test-session.target || return 1
    wait_shell 30 '!Main.layoutManager._startingUp' || return 1
    shell_eval 'Main.overview.hide(); true' > /dev/null || return 1
    wait_shell 10 '!Main.overview.visible && !Main.overview.animationInProgress' || return 1
}

# Log out: stop the session target and graphical-session.target; the units that
# are PartOf graphical-session.target (the updater timer) stop too. GNOME does the
# same at logout: gnome-session-shutdown.target has Conflicts=graphical-session.target.
# Without it, graphical-session.target stays active: xdg-desktop-portal.service has
# Requisite=graphical-session.target.
stop_session() {
    user_systemctl stop gnome-test-session.target graphical-session.target
}

# Waits until the user manager answers (60 s at most).
wait_user_manager() {
    local i state=
    for ((i = 0; i < 120; i++)); do
        state=$(as_user_bare systemctl --user is-system-running 2> /dev/null)
        case $state in running | degraded) return 0 ;; esac
        sleep 0.5
    done
    echo "the user manager of $TEST_USER does not answer (state: ${state:-none})" >&2
    return 1
}

# The user manager must have the cpu and memory controllers, as on a real desktop.
# Without them, systemd does not apply MemoryMax= to the user units and shows no
# MemoryPeak. This happened when a podman exec process was in the root cgroup of the
# container during the boot (run-systemd.sh now waits for init.scope first); a
# daemon-reload does not give the controllers to a running user manager. Waits 10 s at most.
delegated() {
    local i cgroup=/sys/fs/cgroup/user.slice/user-$TEST_UID.slice/user@$TEST_UID.service
    for ((i = 0; i < 20; i++)); do
        grep -qw memory "$cgroup/cgroup.subtree_control" 2> /dev/null &&
            grep -qw cpu "$cgroup/cgroup.subtree_control" && return 0
        sleep 0.5
    done
    echo "# user@$TEST_UID.service: controllers [$(cat "$cgroup/cgroup.controllers" 2> /dev/null)]," \
        "subtree [$(cat "$cgroup/cgroup.subtree_control" 2> /dev/null)]" >&2
    return 1
}

# The user manager starts at boot (linger). If it has no controllers, restart it
# once: the session has not started yet, so nothing is lost.
wait_user_manager || exit 1
if ! delegated; then
    echo "# the user manager has no cpu and memory controllers: restarting user@$TEST_UID.service" >&2
    systemctl daemon-reload
    systemctl restart "user@$TEST_UID.service"
    wait_user_manager || exit 1
    delegated || { echo "the user manager of $TEST_USER has no cpu and memory controllers" >&2; exit 1; }
fi

args=""
desktop=GNOME
if [ "${GNOME_TEST_IMAGE:-}" = ubuntu2404 ]; then
    # The ubuntu mode shows the dock on the left, as on a real Ubuntu desktop (see session.sh).
    args="--mode=ubuntu"
    desktop=ubuntu:GNOME
fi
for m in "${MONITORS[@]}"; do args+=" --virtual-monitor $m"; done
as_user_bare mkdir -p "$TEST_HOME/.config"
# gnome-test-shell.service adds GNOME_TEST_SHELL_ARGS to its fixed options.
as_user_bare sh -c 'printf "%s\n" "$1" "$2" > "$HOME/.config/gnome-test-shell.env"' sh \
    "GNOME_TEST_SHELL_ARGS=$args" "XDG_CURRENT_DESKTOP=$desktop"
# Banners off, as in session.sh: messages stay in the list.
as_user_bare gsettings set org.gnome.desktop.notifications show-banners false
start_session || { echo "the test session did not start; see user-journal.txt" >&2; user_journal > "$OUT/user-journal.txt"; exit 1; }
echo "# $(gnome-shell --version), $(gjs --version), $(systemctl --version | head -n 1)," \
    "monitors ${MONITORS[*]}, user manager of $TEST_USER (uid $TEST_UID)" >&2

(. "$HERE/scenarios/$SCENARIO.sh")
status=$?
user_journal -o short-iso-precise > "$OUT/user-journal.txt" 2>&1
exit $status
