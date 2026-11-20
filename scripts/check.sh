#!/usr/bin/env bash
# The project's verification command: build, then all unit tests.
# This is what Implement and Review run (see issues/Issues.md).
# No AWS access needed. Prints one line per step; only failures print more.
#
# Usage: scripts/check.sh
dir="$(dirname "$0")"
rc=0
"$dir/build.sh" || rc=1
"$dir/test.sh" all || rc=1
if [ "$rc" -eq 0 ]; then echo "CHECK OK"; else echo "CHECK FAILED"; fi
exit "$rc"
