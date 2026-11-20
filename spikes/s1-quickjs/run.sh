#!/usr/bin/env bash
# Spike S1: fetch the pinned QuickJS WASM build, then run the snapshot/restore
# checks. Quiet like scripts/: one line per step, failures only.
# Usage: spikes/s1-quickjs/run.sh
source "$(dirname "$0")/../../scripts/lib.sh"
step s1-fetch-wasm spikes/s1-quickjs/fetch-wasm.sh || finish
SUMMARY_RE='^ℹ pass [0-9]+'
EMPTY_RE='^ℹ tests 0$'
step s1-spike node --test --test-reporter=spec spikes/s1-quickjs/s1.test.ts
# The measurements, for the issue record.
grep -E '^ℹ (linear memory|snapshot)' "$LOG_DIR/s1-spike.log" | sed 's/^/     /'
finish
