#!/usr/bin/env bash
# Installs gnome-air-raid-map for the current user, or uninstalls it (spec 5.8).
# It never needs root: all files go to the folders of the user.
# Usage: ./install.sh              install, or update an installed copy
#        ./install.sh --uninstall  stop the timer, put back the saved wallpaper, delete all files
set -euo pipefail

APP=gnome-air-raid-map
SOURCE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APPDIR=${XDG_DATA_HOME:-$HOME/.local/share}/$APP
UNITDIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
STATEDIR=${XDG_STATE_HOME:-$HOME/.local/state}/$APP
CACHEDIR=${XDG_CACHE_HOME:-$HOME/.cache}/$APP
SAVED=$STATEDIR/previous-wallpaper
# The folders of the pictures of the program: the banner, and the live map.
PICTURE_FOLDERS=("$APPDIR")
if [ -n "${XDG_RUNTIME_DIR:-}" ]; then
    PICTURE_FOLDERS+=("$XDG_RUNTIME_DIR/$APP")
fi
SCHEMA=org.gnome.desktop.background
# The same keys as KEYS in updater/wallpaper.js.
KEYS=(picture-uri picture-uri-dark picture-options primary-color)
TIMER=$APP.timer
UNITS=("$APP.service" "$APP.timer" "$APP-failed.service")

die() {
    printf '%s: %s\n' "$APP" "$*" >&2
    exit 1
}

warn() {
    printf '%s: warning: %s\n' "$APP" "$*" >&2
}

# The value goes into a unit file. systemd splits ExecStart at spaces and expands
# % and $, and sed gives \, & and | a meaning. Stop on these characters.
check_unit_value() {
    case $1 in
        *[[:space:][:cntrl:]\"\'\\%\$\&\|\;]*)
            die "cannot use the path '$1' in a systemd unit: it has a space or one of the characters \" ' \\ % \$ & | ;" ;;
    esac
}

# Prints the absolute path of the program $1, or stops with the packages that have it.
require() {
    local path
    path=$(command -v "$1") || die "$1 is not installed: install the package $2"
    [[ $path == /* ]] || die "$1 is not a program file: $path"
    check_unit_value "$path"
    printf '%s\n' "$path"
}

# points_into <gjs> <value> <folder ...>: the value, a URI as gsettings get prints
# it, points to a file in one of the folders.
points_into() {
    "$1" -c '
        const {Gio, GLib} = imports.gi;
        const [text, ...folders] = ARGV;
        let file = null;
        try {
            const uri = GLib.Variant.parse(null, text, null, null).unpack();
            if (typeof uri === "string") file = Gio.File.new_for_uri(uri);
        } catch (e) {
            // Not a URI: not a picture of the program.
        }
        const inside = file !== null && file.get_path() !== null &&
            folders.some(folder => file.has_prefix(Gio.File.new_for_path(folder)));
        imports.system.exit(inside ? 0 : 1);' "${@:2}"
}

# save_wallpaper <gjs>: saves the wallpaper keys, one "key<TAB>value" line
# for each key, with the value as gsettings prints it. A saved file is never
# replaced: after a second install, the uninstall must still put back the wallpaper
# from before the first install. If the saved file was lost, the wallpaper can show
# a picture of the program (the map or the banner), and then picture-options and
# primary-color are the values of the program too. That is not the wallpaper of the
# user: save no key, and the uninstall resets all four keys to the GNOME defaults.
save_wallpaper() {
    local key value i ours=0 values=() temporary=$SAVED.tmp
    [ -e "$SAVED" ] && return 0
    mkdir -p "$STATEDIR"
    for key in "${KEYS[@]}"; do
        value=$(gsettings get "$SCHEMA" "$key")
        values+=("$value")
        case $key in
            picture-uri | picture-uri-dark)
                if points_into "$1" "$value" "${PICTURE_FOLDERS[@]}"; then
                    warn "$key is $value, a picture of $APP"
                    ours=1
                fi ;;
        esac
    done
    : > "$temporary"
    if [ $ours -eq 1 ]; then
        warn "no wallpaper key is saved, and the uninstall resets all of them to the GNOME defaults"
    else
        for i in "${!KEYS[@]}"; do
            printf '%s\t%s\n' "${KEYS[i]}" "${values[i]}" >> "$temporary"
        done
    fi
    mv "$temporary" "$SAVED"
}

# The new program is built in NEW, next to APPDIR, and then renamed to APPDIR: the
# old program stays complete until the new one is complete. OLD holds the old
# program for the short time of the swap.
NEW=$APPDIR.new
OLD=$APPDIR.old
# Set by install_app. timer_stopped: the install stopped the timer, and the timer
# does not run again. program_broken: the install started to replace the old
# program, and the program in APPDIR or the units are not complete. installed: the
# install is complete.
timer_stopped=0
program_broken=0
installed=0
gsettings=
banner_uri=

# The EXIT trap of the install. If the install fails after it stopped the timer, the
# last map would stay on the screen with its old time and no marking. So start the
# timer again: if the program is broken, its runs fail and the failure unit shows
# the banner. Show the banner now, if a failure script is still there.
# If the swap stopped between its two renames, APPDIR is absent and OLD holds the
# old program, which is complete: move it back first.
# The traps for SIGHUP and SIGTERM make bash wait for a running child and exit with a
# non-zero status. Other termination signals run this trap with status 0. So the trap
# uses installed, and not the status, to know that the install failed.
# set +e: when the terminal is closed, a warning cannot be written, and the recovery
# must not stop there.
recover_failed_install() {
    local status=$? shown=0
    set +e
    trap - EXIT
    if [ "$installed" -eq 0 ]; then
        rm -rf "$NEW"
        if { [ -e "$OLD" ] || [ -L "$OLD" ]; } && [ ! -e "$APPDIR" ] && [ ! -L "$APPDIR" ]; then
            if mv -T "$OLD" "$APPDIR"; then
                program_broken=0
            else
                warn "cannot move $OLD back to $APPDIR"
            fi
        fi
    fi
    if [ "$installed" -eq 0 ] && [ "$timer_stopped" -eq 1 ]; then
        warn "the install failed: starting $TIMER again"
        systemctl --user start "$TIMER" || warn "cannot start $TIMER: run $0 again"
        if [ "$program_broken" -eq 1 ]; then
            if [ -f "$APPDIR/updater/failed.sh" ] && [ -f "$APPDIR/banner.png" ]; then
                shown=1
                /bin/sh "$APPDIR/updater/failed.sh" "$gsettings" "$banner_uri" ||
                    warn "cannot show the failure banner"
            fi
            if [ "$shown" -eq 0 ]; then
                warn "the program in $APPDIR is not complete: run $0 again to install it"
            fi
        fi
    fi
    exit "$status"
}

install_app() {
    local gjs unit name
    gjs=$(require gjs gjs)
    gsettings=$(require gsettings 'glib2 (Fedora) or libglib2.0-bin (Debian, Ubuntu)')
    require systemctl systemd > /dev/null
    "$gjs" -m "$SOURCE/updater/check-deps.js" || die "install the missing packages, then run $0 again"
    systemctl --user show-environment > /dev/null ||
        die "no systemd user session: systemctl --user does not answer"
    check_unit_value "$APPDIR"
    banner_uri=$("$gjs" -c 'print(imports.gi.Gio.File.new_for_path(ARGV[0]).get_uri())' "$APPDIR/banner.png")

    # 1. The program. Build it in NEW, and swap it in with renames. Until the swap,
    # the old program and its failure script are not changed, so a failed copy (for
    # example a full disk) leaves the old program working. A run that starts during
    # the swap fails and shows the banner. So stop the timer and a run that is in
    # progress first; step 4 starts the timer again. If a step fails before that,
    # the EXIT trap starts the timer again.
    trap recover_failed_install EXIT
    # Without these traps, bash runs the EXIT trap at once on SIGHUP or SIGTERM, with a
    # child (cp, mv, systemctl) still running and with status 0. With them, bash waits
    # for the child, and the status is not 0.
    trap 'exit 129' HUP
    trap 'exit 143' TERM
    if systemctl --user is-active --quiet "$TIMER"; then
        timer_stopped=1
        systemctl --user stop "$TIMER"
    fi
    # A run in progress is not active, so stopping the timer does not stop it.
    if [ -e "$UNITDIR/$APP.service" ]; then
        systemctl --user stop "$APP.service" || warn "cannot stop $APP.service"
    fi
    # A swap that a SIGKILL or a power loss stopped leaves APPDIR absent and the only
    # complete program in OLD: move it back before the next line deletes it.
    if [ ! -e "$APPDIR" ] && [ ! -L "$APPDIR" ] && { [ -e "$OLD" ] || [ -L "$OLD" ]; }; then
        mv -T "$OLD" "$APPDIR"
    fi
    # Delete what an earlier install that stopped left.
    rm -rf "$NEW" "$OLD"
    mkdir -p "$(dirname "$APPDIR")" "$NEW"
    cp -R "$SOURCE/core" "$SOURCE/updater" "$NEW/"
    cp "$SOURCE/LICENSE" "$NEW/"
    "$gjs" -m "$NEW/updater/banner.js" "$NEW/banner.png"
    if [ -e "$APPDIR" ] || [ -L "$APPDIR" ]; then
        mv -T "$APPDIR" "$OLD"
    fi
    # From here the program in APPDIR is not complete until the next rename is done.
    program_broken=1
    mv -T "$NEW" "$APPDIR"
    rm -rf "$OLD"

    # 2. The units. In a unit file, %% is one %: the banner URI escapes some
    # characters as %XX.
    mkdir -p "$UNITDIR"
    for unit in "$SOURCE"/systemd/*; do
        name=$(basename "${unit%.in}")
        sed -e "s|@GJS@|$gjs|g" -e "s|@GSETTINGS@|$gsettings|g" -e "s|@APPDIR@|$APPDIR|g" \
            -e "s|@BANNER_URI@|${banner_uri//%/%%}|g" "$unit" > "$UNITDIR/$name"
        if grep -q '@[A-Z_]*@' "$UNITDIR/$name"; then
            die "a value in $UNITDIR/$name is not replaced"
        fi
    done
    program_broken=0

    # 3. The wallpaper from before the install.
    save_wallpaper "$gjs"

    # 4. The timer. Without a graphical session (for example over SSH or on a
    # text console) every run fails, so only enable the timer: it starts with
    # graphical-session.target at the next graphical login.
    systemctl --user daemon-reload
    if systemctl --user is-active --quiet graphical-session.target; then
        systemctl --user enable --now "$TIMER"
        echo "$APP: installed. The wallpaper shows the map within a few seconds."
    else
        systemctl --user enable "$TIMER"
        echo "$APP: installed. No graphical session runs now: the map starts at the next graphical login."
    fi
    timer_stopped=0
    installed=1
    echo "$APP: to uninstall, run: $0 --uninstall"
}

# Clears the failed state of the units. A unit that is not loaded has no state:
# systemctl then prints "... not loaded." and that is not an error here.
reset_failed() {
    local line
    while IFS= read -r line; do
        case $line in
            *' not loaded'*) ;;
            *) warn "$line" ;;
        esac
    done < <(systemctl --user reset-failed "$@" 2>&1)
}

uninstall_app() {
    local gjs key value unit restored=1 saved=' ' ours=0
    # Stop the timer first: a run after the restore would set the map again.
    systemctl --user disable --now "$TIMER" || warn "cannot stop $TIMER"
    # A run that fails while it stops (for example at its start timeout) queues
    # the failure unit (OnFailure=). So stop the failure unit in a later call than
    # the service: this cancels a queued start or ends a running one, and its
    # gsettings calls cannot come after the restore below.
    systemctl --user stop "$APP.service" || warn "cannot stop $APP.service"
    systemctl --user stop "$APP-failed.service" || warn "cannot stop $APP-failed.service"
    reset_failed "$APP.service" "$APP-failed.service"

    if [ -f "$SAVED" ]; then
        while IFS=$'\t' read -r key value; do
            case " ${KEYS[*]} " in
                *" $key "*)
                    saved+="$key "
                    gsettings set "$SCHEMA" "$key" "$value" || {
                        warn "cannot set $key to $value"
                        restored=0
                    } ;;
                *) warn "$SAVED: unknown key '$key'" ;;
            esac
        done < "$SAVED"
        # A key without a line had a picture of the program at the install (save_wallpaper).
        for key in "${KEYS[@]}"; do
            case $saved in
                *" $key "*) ;;
                *) gsettings reset "$SCHEMA" "$key" || {
                        warn "cannot reset $key"
                        restored=0
                    } ;;
            esac
        done
    else
        # Without the saved file, only a key that shows a picture of the program is
        # reset: the program deletes that picture below. If one does, picture-options
        # and primary-color have the values of the program too.
        warn "no saved wallpaper in $SAVED: only the keys that show a picture of $APP are reset"
        if gjs=$(command -v gjs); then
            for key in picture-uri picture-uri-dark; do
                value=$(gsettings get "$SCHEMA" "$key") || value=
                if points_into "$gjs" "$value" "${PICTURE_FOLDERS[@]}"; then
                    ours=1
                    gsettings reset "$SCHEMA" "$key" || {
                        warn "cannot reset $key"
                        restored=0
                    }
                fi
            done
            if [ $ours -eq 1 ]; then
                for key in picture-options primary-color; do
                    gsettings reset "$SCHEMA" "$key" || {
                        warn "cannot reset $key"
                        restored=0
                    }
                done
            fi
        else
            warn "gjs is not installed: the wallpaper keys stay as they are"
        fi
    fi

    for unit in "${UNITS[@]}"; do
        rm -f "$UNITDIR/$unit"
    done
    rm -rf "$APPDIR" "$NEW" "$OLD" "$CACHEDIR"
    if [ -n "${XDG_RUNTIME_DIR:-}" ]; then
        rm -rf "$XDG_RUNTIME_DIR/$APP"
    fi
    systemctl --user daemon-reload || warn "systemctl --user daemon-reload failed"
    # Keep the saved wallpaper if a key was not put back, so that the user can
    # set it by hand or run the uninstall again.
    [ $restored -eq 1 ] || die "uninstalled, but the wallpaper settings are not all put back: see $SAVED"
    rm -rf "$STATEDIR"
    echo "$APP: uninstalled."
}

[ $# -le 1 ] || die "usage: $0 [--uninstall]"
# A relative XDG folder would make the paths depend on the current folder.
for dir in "$APPDIR" "$UNITDIR" "$STATEDIR" "$CACHEDIR"; do
    [[ $dir == /* ]] || die "the XDG folders must be absolute paths, not '$dir'"
done
case ${1:-} in
    '') install_app ;;
    --uninstall) uninstall_app ;;
    *) die "usage: $0 [--uninstall]" ;;
esac
