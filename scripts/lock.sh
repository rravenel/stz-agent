#!/usr/bin/env bash
# Re-resolve the lock files after a dependency change, then install from them.
# A person runs this (network access; agents can't install packages).
#
#   requirements.txt + requirements-dev.txt -> requirements.lock
#       (uv pip compile: hashes, every platform, Python from .python-version)
#   <pkg>/package.json                       -> <pkg>/package-lock.json
#
# Usage: scripts/lock.sh            # re-lock, keeping versions that still fit
#        scripts/lock.sh --upgrade  # re-lock to the newest allowed versions
# Commit the changed lock files with the dependency change.
source "$(dirname "$0")/lib.sh"

upgrade=""; [ "${1:-}" = --upgrade ] && upgrade=1

if ! command -v uv >/dev/null; then
  echo "FAIL lock: uv not found (brew install uv)" >&2; exit 1
fi
step pip-compile uv pip compile requirements.txt requirements-dev.txt \
  --universal --generate-hashes --no-header --python-version "$PY_WANT" \
  ${upgrade:+--upgrade} -o requirements.lock

for pkg in $(ts_packages); do
  if [ -n "$upgrade" ]; then
    step "npm-lock-$pkg" npm --prefix "$pkg" update --package-lock-only --no-audit --no-fund
  else
    step "npm-lock-$pkg" npm --prefix "$pkg" install --package-lock-only --no-audit --no-fund
  fi
done

if [ "$FAILED" -eq 0 ]; then "$ROOT/scripts/setup.sh" || FAILED=1; fi
finish
