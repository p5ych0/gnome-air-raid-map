#!/usr/bin/env bash
# Runs every tests/unit/test-*.js with GJS; exits non-zero if any file fails.
# A file that runs for more than 600 s fails, so a test that waits forever (#7)
# does not stop the suite.
set -u
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export TZ=UTC LC_ALL=C.UTF-8 GSETTINGS_BACKEND=memory
status=0
for file in "$root"/tests/unit/test-*.js; do
    name=$(basename "$file")
    echo "# $name"
    code=0
    timeout 600 gjs -m "$file" || code=$?
    # timeout exits 124 when the time limit stops the file.
    [ $code -ne 124 ] || echo "not ok - $name: timeout after 600 s"
    [ $code -eq 0 ] || status=1
done
exit $status
