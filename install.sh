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

# Saves the wallpaper keys, one "key<TAB>value" line for each key, with the value
# as gsettings prints it. A saved file is never replaced: after a second install,
# the uninstall must still put back the wallpaper from before the first install.
save_wallpaper() {
    local key value temporary=$SAVED.tmp
    [ -e "$SAVED" ] && return 0
    mkdir -p "$STATEDIR"
    : > "$temporary"
    for key in "${KEYS[@]}"; do
        value=$(gsettings get "$SCHEMA" "$key")
        printf '%s\t%s\n' "$key" "$value" >> "$temporary"
    done
    mv "$temporary" "$SAVED"
}

install_app() {
    local gjs gsettings banner_uri unit name
    gjs=$(require gjs gjs)
    gsettings=$(require gsettings 'glib2 (Fedora) or libglib2.0-bin (Debian, Ubuntu)')
    require systemctl systemd > /dev/null
    "$gjs" -m "$SOURCE/updater/check-deps.js" || die "install the missing packages, then run $0 again"
    systemctl --user show-environment > /dev/null ||
        die "no systemd user session: systemctl --user does not answer"
    check_unit_value "$APPDIR"

    # 1. The program.
    mkdir -p "$APPDIR"
    rm -rf "$APPDIR/core" "$APPDIR/updater"
    cp -R "$SOURCE/core" "$SOURCE/updater" "$APPDIR/"
    cp "$SOURCE/LICENSE" "$APPDIR/"

    # 2. The units. In a unit file, %% is one %: the banner URI escapes some
    # characters as %XX.
    banner_uri=$("$gjs" -c 'print(imports.gi.Gio.File.new_for_path(ARGV[0]).get_uri())' "$APPDIR/banner.png")
    mkdir -p "$UNITDIR"
    for unit in "$SOURCE"/systemd/*; do
        name=$(basename "${unit%.in}")
        sed -e "s|@GJS@|$gjs|g" -e "s|@GSETTINGS@|$gsettings|g" -e "s|@APPDIR@|$APPDIR|g" \
            -e "s|@BANNER_URI@|${banner_uri//%/%%}|g" "$unit" > "$UNITDIR/$name"
        if grep -q '@[A-Z_]*@' "$UNITDIR/$name"; then
            die "a value in $UNITDIR/$name is not replaced"
        fi
    done

    # 3. The wallpaper from before the install.
    save_wallpaper

    # 4. The failure banner.
    "$gjs" -m "$APPDIR/updater/banner.js" "$APPDIR/banner.png"

    # 5. The timer.
    systemctl --user daemon-reload
    systemctl --user enable --now "$TIMER"
    echo "$APP: installed. The wallpaper shows the map within a few seconds."
    echo "$APP: to uninstall, run: $0 --uninstall"
}

uninstall_app() {
    local key value unit restored=1
    # Stop the timer first: a run after the restore would set the map again.
    systemctl --user disable --now "$TIMER" || warn "cannot stop $TIMER"
    systemctl --user stop "$APP.service" "$APP-failed.service" || warn "cannot stop the services"

    if [ -f "$SAVED" ]; then
        while IFS=$'\t' read -r key value; do
            case " ${KEYS[*]} " in
                *" $key "*)
                    gsettings set "$SCHEMA" "$key" "$value" || {
                        warn "cannot set $key to $value"
                        restored=0
                    } ;;
                *) warn "$SAVED: unknown key '$key'" ;;
            esac
        done < "$SAVED"
    else
        warn "no saved wallpaper in $SAVED: the wallpaper settings stay as they are"
    fi

    for unit in "${UNITS[@]}"; do
        rm -f "$UNITDIR/$unit"
    done
    rm -rf "$APPDIR" "$CACHEDIR"
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
