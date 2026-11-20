# shellcheck shell=bash
# Shared helpers for scripts/*.sh. Source it; don't run it.
#
# Contract for every script in scripts/:
#   - Full tool output goes to .logs/<step>.log, never to stdout.
#   - On success a step prints ONE line:  ok   <step> (<secs>s) [summary]
#   - On failure it prints:               FAIL <step> (exit N, <secs>s) log: .logs/<step>.log
#     followed by a short excerpt of the error lines (at most $FAIL_LINES lines).
#   - The script exits non-zero if any step failed.
# This keeps agent context small: only failures are worth reading.
# VERBOSE=1 streams full output as well (for humans debugging a step).

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${STZ_LOG_DIR:-$ROOT/.logs}"
VERBOSE="${VERBOSE:-0}"
FAIL_LINES="${FAIL_LINES:-40}"
FAILED=0
mkdir -p "$LOG_DIR"
cd "$ROOT" || exit 2

# Print the lines of a failed log that explain the failure, capped and truncated.
failure_excerpt() {
  local log="$1" hits
  hits="$(grep -E -i -n '(error|fail|exception|traceback|assert|cannot|not found|denied|✗|×)' "$log" \
          | grep -v -E '^[0-9]+:\s*$' | tail -n "$FAIL_LINES")"
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits"
  else
    tail -n "$FAIL_LINES" "$log"
  fi | cut -c1-300 | sed 's/^/     /'
}

# Last line of a log matching a pattern, ANSI codes stripped ("12 passed in 1.2s").
summary_from() {
  sed -E 's/\x1b\[[0-9;]*m//g' "$1" 2>/dev/null | grep -E "$2" | tail -n 1 \
    | sed -E 's/^[ =]+|[ =]+$//g' | cut -c1-200
}

# step <name> <command...>
# Runs the command quietly and reports one line. Returns non-zero on failure.
# Optional, reset after each step:
#   SUMMARY_RE  regex; the last matching log line is appended to the ok/FAIL line
#   EMPTY_RE    regex; if it matches the log, the step fails even on exit 0
#               (used to catch "no tests ran")
step() {
  local name="$1"; shift
  local log="$LOG_DIR/$name.log" start=$SECONDS rc summary=""
  if [ "$VERBOSE" = 1 ]; then
    "$@" 2>&1 | tee "$log"; rc=${PIPESTATUS[0]}
  else
    "$@" >"$log" 2>&1; rc=$?
  fi
  if [ "$rc" -eq 0 ] && [ -n "${EMPTY_RE:-}" ] \
     && sed -E 's/\x1b\[[0-9;]*m//g' "$log" | grep -q -E -i "$EMPTY_RE"; then
    echo "step: no tests ran (matched: $EMPTY_RE)" >>"$log"; rc=1
  fi
  [ -n "${SUMMARY_RE:-}" ] && summary="$(summary_from "$log" "$SUMMARY_RE")"
  SUMMARY_RE=""; EMPTY_RE=""
  local secs=$((SECONDS - start))
  if [ "$rc" -eq 0 ]; then
    printf 'ok   %s (%ss)%s\n' "$name" "$secs" "${summary:+ $summary}"
  else
    printf 'FAIL %s (exit %s, %ss)%s log: %s\n' "$name" "$rc" "$secs" \
      "${summary:+ $summary;}" "${log#"$ROOT"/}"
    failure_excerpt "$log"
    FAILED=1
  fi
  return "$rc"
}

# The Python interpreter in the project venv. Fails clearly if setup has not run.
venv_python() {
  if [ ! -x "$ROOT/.venv/bin/python" ]; then
    echo "FAIL setup: .venv missing; run scripts/setup.sh" >&2
    return 1
  fi
  check_venv_python || return 1
  printf '%s\n' "$ROOT/.venv/bin/python"
}

# The pinned toolchain: .python-version (exact minor) and .nvmrc (Node major).
PY_WANT="$(tr -d '[:space:]' <"$ROOT/.python-version")"
NODE_WANT="$(tr -d '[:space:]' <"$ROOT/.nvmrc")"

# Prints "major.minor" of a Python interpreter.
py_minor() { "$1" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null; }

# Fails if the venv's Python is not the pinned version (a venv made with
# another interpreter would resolve different wheels).
check_venv_python() {
  local have; have="$(py_minor "$ROOT/.venv/bin/python")"
  if [ "$have" != "$PY_WANT" ]; then
    echo "FAIL setup: .venv is Python ${have:-?}, need $PY_WANT (.python-version); run scripts/setup.sh" >&2
    return 1
  fi
}

# Warns (never fails) when local Node's major differs from .nvmrc. Bundles are
# pinned by esbuild's `target`, so a newer Node still builds the same output,
# but tests run on the local Node.
check_node() {
  local have; have="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
  if [ "$have" != "$NODE_WANT" ]; then
    echo "warn node is v${have:-?}, .nvmrc pins $NODE_WANT (Lambda runtime); tests run on the local Node"
  fi
}

# The CDK CLI pinned in functions/package.json (exact version, in the lockfile).
cdk_cli() {
  local bin="$ROOT/functions/node_modules/.bin/cdk"
  if [ ! -x "$bin" ]; then
    echo "FAIL setup: pinned CDK CLI missing ($bin); run scripts/setup.sh" >&2
    return 1
  fi
  printf '%s\n' "$bin"
}

# TypeScript package directories that exist (functions/ workspace, client/).
ts_packages() {
  local d
  for d in functions client; do
    [ -f "$ROOT/$d/package.json" ] && printf '%s\n' "$d"
  done
}

# True if package.json in dir $1 defines npm script $2.
has_npm_script() {
  node -e 'const p=require(process.argv[1]); process.exit(p.scripts && p.scripts[process.argv[2]] ? 0 : 1)' \
    "$ROOT/$1/package.json" "$2" 2>/dev/null
}

finish() {
  if [ "$FAILED" -ne 0 ]; then exit 1; fi
  exit 0
}
