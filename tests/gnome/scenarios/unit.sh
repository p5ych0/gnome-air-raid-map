# Scenario: runs the unit suite with the GJS of the image (sourced by session.sh).
/repo/tests/run.sh 2>&1 | tee "$OUT/unit.txt"
status=${PIPESTATUS[0]}
echo "# unit: $(grep -c '^ok - ' "$OUT/unit.txt") ok, $(grep -c '^not ok - ' "$OUT/unit.txt") not ok"
exit "$status"
