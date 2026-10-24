# Scenario: picture reload for each method of updater/writer.js (spec 5.6).
# Sourced by session.sh. Prints one line per method: <method> <passed>/<updates>.
# The rules are in reload.js. Details: $OUT/reload-<method>.tsv, a screenshot
# of update 1, and the screenshots of the first failed updates.
# GNOME_TEST_UPDATES changes the number of updates (default 100), and
# GNOME_TEST_METHODS the methods (default "in-place rename alternate").
UPDATES=${GNOME_TEST_UPDATES:-100}
status=0
for method in ${GNOME_TEST_METHODS:-in-place rename alternate}; do
    # A mark in shell.log, to find the Shell messages of each method.
    shell_eval "log('reload.sh: method $method'); true" > /dev/null
    gjs -m "$HERE/scenarios/reload.js" "$method" "$UPDATES" "$OUT" || status=1
done
exit $status
