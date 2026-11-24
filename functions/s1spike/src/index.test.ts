import { test } from "node:test";
import assert from "node:assert/strict";
import { loadWasm } from "../../prime/src/repl/wasm.ts";
import { restoreAndCheck, takeSnapshot } from "./index.ts";

test("S1 spike: a snapshot taken mid-await restores and passes every check", async () => {
  const wasm = loadWasm();
  const { snap, pending } = await takeSnapshot(wasm);
  assert.deepEqual(pending, { status: "pending" });
  const r = await restoreAndCheck(wasm, snap);
  assert.ok(r.pass, JSON.stringify(r.checks));
});
