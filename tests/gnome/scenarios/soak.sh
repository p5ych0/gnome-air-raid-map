# Scenario: one container of the GNOME soak (plan Task 11, spec 7.4 checks 4 and 5).
# Sourced by session-systemd.sh, as root, in a container where systemd is PID 1
# (tests/gnome/run-systemd.sh). tests/leak/soak.sh starts three of these containers
# at the same time, with the roles:
# - updater: installs the program with the real install.sh as the test user. The
#   real timer then runs the updater every 30 s against NEPTUN (no API override).
# - updater-unchanged: the same, with a drop-in that sets
#   AIR_RAID_MAP_LABEL_MODE=unchanged for the service (spec 5.6, fallback B).
# - control: the same GNOME session without the updater.
# All start soak-sampler.sh as a system service of the container. It samples for
# GNOME_TEST_SOAK_SECONDS and then stops the container. The scenario returns when
# the sampler runs (run-systemd.sh with GNOME_TEST_DETACH=1 leaves the container).
# Variables: GNOME_TEST_SOAK_ROLE (updater | updater-unchanged | control),
# GNOME_TEST_SOAK_SECONDS (default 86400), GNOME_TEST_SOAK_GC_INTERVAL (seconds
# between the GC probes of the sampler; default 3600), GNOME_TEST_SOAK_POWEROFF (1:
# stop the container at the end; default 1).
ROLE=${GNOME_TEST_SOAK_ROLE:-updater}
SOAK_SECONDS=${GNOME_TEST_SOAK_SECONDS:-86400}
GC_INTERVAL=${GNOME_TEST_SOAK_GC_INTERVAL:-3600}
SERVICE=gnome-air-raid-map.service
case $ROLE in updater | updater-unchanged | control) ;;
    *) echo "GNOME_TEST_SOAK_ROLE must be updater, updater-unchanged or control" >&2; exit 2 ;;
esac
[[ $SOAK_SECONDS =~ ^[1-9][0-9]*$ ]] || { echo "GNOME_TEST_SOAK_SECONDS must be a number of seconds" >&2; exit 2; }
[[ $GC_INTERVAL =~ ^[1-9][0-9]*$ ]] || { echo "GNOME_TEST_SOAK_GC_INTERVAL must be a number of seconds" >&2; exit 2; }

{
    echo "role $ROLE, $SOAK_SECONDS s, GC probe every $GC_INTERVAL s, start $(date -Is)"
    echo "$(gnome-shell --version), $(gjs --version), $(systemctl --version | head -n 1)"
    echo "monitors: $(shell_eval 'Main.layoutManager.monitors.map(m => [m.x, m.y, m.width, m.height, m.geometry_scale])')"
    echo "user manager environment: $(user_systemctl show-environment | tr '\n' ' ')"
} > "$OUT/soak-info.txt"
sed 's/^/# /' "$OUT/soak-info.txt"

if [ "$ROLE" != control ]; then
    if [ "$ROLE" = updater-unchanged ]; then
        # The drop-in exists before the install, so the first run already uses it.
        dropin=$(as_user sh -c 'printf "%s\n" "${XDG_CONFIG_HOME:-$HOME/.config}"')/systemd/user/$SERVICE.d
        as_user_bare mkdir -p "$dropin"
        as_user_bare sh -c 'printf "%s\n" "[Service]" "Environment=AIR_RAID_MAP_LABEL_MODE=unchanged" > "$1"' \
            sh "$dropin/label-mode.conf"
    fi
    as_user /repo/install.sh > "$OUT/install.stdout" 2> "$OUT/install.stderr" || {
        echo "not ok - install.sh exits 0"
        cat "$OUT/install.stdout" "$OUT/install.stderr"
        exit 1
    }
    echo "ok - install.sh exits 0"
    user_systemctl show -p MemoryMax -p TimeoutStartUSec -p OnFailure -p Environment $SERVICE | sed 's/^/# /'
    environment=$(user_systemctl show -p Environment --value $SERVICE)
    if [ "$ROLE" = updater-unchanged ]; then
        expected=unchanged
        [[ " $environment " == *" AIR_RAID_MAP_LABEL_MODE=unchanged "* ]]
    else
        expected="updated (the default)"
        [[ " $environment " != *AIR_RAID_MAP_LABEL_MODE* ]]
    fi && echo "ok - the label mode of the service is $expected" || {
        echo "not ok - the label mode of the service is $expected"
        exit 1
    }
    echo "label mode: $expected" >> "$OUT/soak-info.txt"
    # The first timer run must end, and systemd must record its MemoryPeak: else
    # the soak would run for a day without the numbers of spec 7.4, check 4.
    for ((i = 0; i < 90; i++)); do
        [ -n "$(user_systemctl show -p InvocationID --value $SERVICE)" ] &&
            [ "$(user_systemctl show -p ActiveState --value $SERVICE)" != activating ] && break
        sleep 0.5
    done
    first=$(user_systemctl show -p Result -p MemoryPeak -p CPUUsageNSec $SERVICE | tr '\n' ' ')
    echo "# first run: $first"
    if [[ $first =~ MemoryPeak=[0-9]+ ]]; then
        echo "ok - systemd records the MemoryPeak of a run"
    else
        echo "not ok - systemd records the MemoryPeak of a run"
        exit 1
    fi
fi

systemd-run --quiet --unit=gnome-test-soak -E "GNOME_TEST_SOAK_POWEROFF=${GNOME_TEST_SOAK_POWEROFF:-1}" \
    -E "GNOME_TEST_SOAK_GC_INTERVAL=$GC_INTERVAL" /repo/tests/gnome/soak-sampler.sh "$SOAK_SECONDS" || exit 1
echo "ok - the sampler runs for $SOAK_SECONDS s"
