#!/usr/bin/env bash
# Runs every tests/unit/test-*.js with GJS; exits non-zero if any file fails.
set -u
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export TZ=UTC LC_ALL=C.UTF-8 GSETTINGS_BACKEND=memory
status=0
for file in "$root"/tests/unit/test-*.js; do
    echo "# $(basename "$file")"
    gjs -m "$file" || status=1
done
exit $status
