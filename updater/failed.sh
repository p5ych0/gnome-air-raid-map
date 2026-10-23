#!/bin/sh
# SPDX-License-Identifier: MIT
# The failure banner (spec 5.7): gnome-air-raid-map-failed.service runs this script
# when a run of the updater fails. It only runs gsettings, so it cannot fail for the
# same reason as the updater (no GJS, Cairo or Pango). It sets a key only when the
# key has another value: while the runs fail, the unit runs every 30 seconds, and
# dconf then writes nothing again.
# Usage: failed.sh <gsettings> <banner-uri>
set -eu

if [ $# -ne 2 ]; then
    echo 'usage: failed.sh <gsettings> <banner-uri>' >&2
    exit 2
fi
gsettings=$1
schema=org.gnome.desktop.background
# The value is GVariant text, as gsettings get prints it: the URI in single quotes.
# install.sh does not accept ' or \ in the folder of the banner.
case $2 in
    *[\'\\]*)
        echo "failed.sh: the banner URI has ' or \\: $2" >&2
        exit 2 ;;
esac

# show <key> <value>: sets the key to the value (GVariant text) if it has another value.
show() {
    current=$("$gsettings" get "$schema" "$1") || current=
    if [ "$current" != "$2" ]; then
        "$gsettings" set "$schema" "$1" "$2"
    fi
}

show picture-uri "'$2'"
show picture-uri-dark "'$2'"
show picture-options "'centered'"
show primary-color "'#0e1722'"
