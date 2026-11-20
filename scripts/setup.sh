#!/usr/bin/env bash
# Install local dependencies, exactly as locked: the Python venv from
# requirements.lock (hash-checked) and node_modules for each TypeScript package
# with `npm ci` from its package-lock.json. Safe to re-run. No AWS access needed.
#
# The interpreter must match .python-version; it is found as python3.X on PATH,
# else via uv (`uv python install 3.X` gets one). Never falls back to another
# version. Change dependencies with scripts/lock.sh, not by editing the lock.
#
# Usage: scripts/setup.sh
source "$(dirname "$0")/lib.sh"

find_python() {
  local p
  p="$(command -v "python$PY_WANT" || true)"
  if [ -z "$p" ] && command -v uv >/dev/null; then
    p="$(uv python find --no-project "$PY_WANT" 2>/dev/null || true)"
  fi
  if [ -z "$p" ] || [ "$(py_minor "$p")" != "$PY_WANT" ]; then
    echo "FAIL setup: Python $PY_WANT not found (.python-version)." >&2
    echo "     install it, e.g.: uv python install $PY_WANT  (or brew install python@$PY_WANT)" >&2
    return 1
  fi
  printf '%s\n' "$p"
}

# Recreate the venv if it is missing or was made with another Python.
if [ -x .venv/bin/python ] && ! check_venv_python 2>/dev/null; then
  rm -rf .venv
fi
if [ ! -x .venv/bin/python ]; then
  PY="$(find_python)" || exit 1
  step venv "$PY" -m venv .venv || finish
fi
SUMMARY_RE='.'
step python-version .venv/bin/python --version
step pip-install .venv/bin/python -m pip install -q --require-hashes --no-deps \
  -r requirements.lock

check_node
for pkg in $(ts_packages); do
  if [ ! -f "$pkg/package-lock.json" ]; then
    echo "FAIL npm-ci-$pkg: $pkg/package-lock.json missing; run scripts/lock.sh" >&2
    FAILED=1; continue
  fi
  step "npm-ci-$pkg" npm --prefix "$pkg" ci --no-audit --no-fund
done

finish
