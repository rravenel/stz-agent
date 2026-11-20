#!/usr/bin/env bash
# Run unit tests quietly: Python (pytest, CDK assertions) and TypeScript
# (`npm test` in each TS package that defines it: node --test or vitest). A suite that runs zero
# tests counts as a failure.
#
# Usage: scripts/test.sh [all|py|ts] [extra args for the test runner]
#   scripts/test.sh                  # everything
#   scripts/test.sh py -k queue      # pytest args
#   scripts/test.sh ts               # every TS package
# Output: one summary line per suite; failures print an excerpt and the log path.
source "$(dirname "$0")/lib.sh"

what="${1:-all}"; [ $# -gt 0 ] && shift

run_py() {
  local py; py="$(venv_python)" || { FAILED=1; return; }
  # pytest exits 5 when it collects no tests, so an empty suite already fails.
  SUMMARY_RE='[0-9]+ (passed|failed|error)|no tests ran'
  step pytest "$py" -m pytest -q -rfE --tb=short -p no:cacheprovider "$@"
}

run_ts() {
  local pkg
  for pkg in $(ts_packages); do
    has_npm_script "$pkg" test || continue
    # node --test (spec reporter) ends with "ℹ tests N / ℹ pass N / ℹ fail N";
    # vitest prints "Tests  N passed". Either runner works.
    SUMMARY_RE='^ℹ pass [0-9]+|^ *Tests +[0-9]'
    EMPTY_RE='^ℹ tests 0$|no test files found|Tests +0 '
    step "test-$pkg" npm --prefix "$pkg" test -s -- "$@"
  done
}

case "$what" in
  py)  run_py "$@" ;;
  ts)  run_ts "$@" ;;
  all) run_py; run_ts ;;
  *)   echo "usage: scripts/test.sh [all|py|ts] [args...]" >&2; exit 2 ;;
esac

finish
