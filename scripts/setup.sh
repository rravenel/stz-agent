#!/usr/bin/env bash
# Install local dependencies: the Python venv (CDK + pytest) and node_modules
# for each TypeScript package. Safe to re-run. No AWS access needed.
#
# Usage: scripts/setup.sh
source "$(dirname "$0")/lib.sh"

# README asks for Python 3.12; use it when present, else the default python3.
PY="$(command -v python3.12 || command -v python3)"
if [ ! -x .venv/bin/python ]; then
  step venv "$PY" -m venv .venv || finish
fi
SUMMARY_RE='.'
step python-version .venv/bin/python --version
step pip-install .venv/bin/python -m pip install -q -r requirements.txt -r requirements-dev.txt

for pkg in $(ts_packages); do
  if [ -f "$pkg/package-lock.json" ]; then
    step "npm-ci-$pkg" npm --prefix "$pkg" ci --no-audit --no-fund
  else
    step "npm-install-$pkg" npm --prefix "$pkg" install --no-audit --no-fund
  fi
done

finish
