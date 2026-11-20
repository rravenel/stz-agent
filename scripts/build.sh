#!/usr/bin/env bash
# Build everything without touching AWS:
#   1. TypeScript: `typecheck` then `build` (esbuild bundles) in each TS package
#      that defines those npm scripts (functions/, client/).
#   2. CDK: synthesize the app (python app.py) into cdk.out/. Runs after the TS
#      build because the stack references the bundled function code.
#
# Usage: scripts/build.sh
# Output: one line per step; failures print an excerpt and the log path.
source "$(dirname "$0")/lib.sh"

for pkg in $(ts_packages); do
  for s in typecheck build; do
    if has_npm_script "$pkg" "$s"; then
      step "$s-$pkg" npm --prefix "$pkg" run -s "$s" || true
    fi
  done
done

PY="$(venv_python)" || exit 1
# CDK_OUTDIR makes app.synth() write a cloud assembly without the cdk CLI.
# The env name is pinned so synth is the same on every machine.
step cdk-synth env CDK_OUTDIR="$ROOT/cdk.out" CDK_CONTEXT_JSON='{"env":"build"}' \
  "$PY" app.py

finish
