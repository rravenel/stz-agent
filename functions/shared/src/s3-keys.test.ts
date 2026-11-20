import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LATEST_CHECKPOINT_KEY,
  checkpointReplKey,
  checkpointStateKey,
  logKey,
  requestBodyKey,
  responseBodyKey,
  seqFromLogKey,
  workspaceKey,
} from "./s3-keys.ts";

test("log keys are zero-padded to 10 digits and sort lexically", () => {
  assert.equal(logKey(42), "log/0000000042.json");
  assert.equal(logKey(0), "log/0000000000.json");
  const keys = [logKey(9), logKey(10), logKey(100)];
  assert.deepEqual([...keys].sort(), keys);
  assert.equal(seqFromLogKey(logKey(312)), 312);
  assert.equal(seqFromLogKey("log/42.json"), null);
});

test("log keys reject negative, fractional and oversized seq", () => {
  assert.throws(() => logKey(-1), RangeError);
  assert.throws(() => logKey(1.5), RangeError);
  assert.throws(() => logKey(1e10), RangeError);
});

test("body, checkpoint and latest keys follow spec §4", () => {
  assert.equal(requestBodyKey("req-1"), "bodies/req-1.req");
  assert.equal(responseBodyKey("req-1"), "bodies/req-1.res");
  assert.equal(checkpointStateKey(17), "prime/ckpt-17/state.json");
  assert.equal(checkpointReplKey(17), "prime/ckpt-17/repl.bin");
  assert.equal(LATEST_CHECKPOINT_KEY, "prime/latest.json");
});

test("ids and workspace paths cannot escape their prefix", () => {
  assert.throws(() => requestBodyKey("../prime/latest"), RangeError);
  assert.throws(() => responseBodyKey("a/b"), RangeError);
  assert.equal(workspaceKey("scripts/fetch.js"), "workspace/scripts/fetch.js");
  for (const bad of ["", "/etc/passwd", "a/../b", "./a", "a//b"]) {
    assert.throws(() => workspaceKey(bad), RangeError, bad);
  }
});
