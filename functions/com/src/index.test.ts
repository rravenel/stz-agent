import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptDeadline, MARGIN_MS, runUntilDrained, type PassResult } from "./index.ts";

test("acceptDeadline: run end minus a 60 s margin", () => {
  assert.equal(MARGIN_MS, 60_000);
  assert.equal(acceptDeadline(1_000, 900_000), 1_000 + 900_000 - 60_000);
});

test("runUntilDrained: goes round again only for released work, after a normal exit, with time left", async () => {
  const go = async (passes: PassResult[], time = true) => {
    let n = 0;
    const r = await runUntilDrained(async () => passes[n++]!, () => time);
    return { n, ...r };
  };
  const pass = (exit: string, released: number): PassResult => ({ exit, released, handled: 1 });
  assert.deepEqual(await go([pass("idle", 0)]), { n: 1, exit: "idle", released: 0, handled: 1 });
  assert.deepEqual(await go([pass("idle", 1), pass("idle", 0)]), { n: 2, exit: "idle", released: 0, handled: 2 });
  assert.equal((await go([pass("idle", 1)], false)).n, 1);
  assert.equal((await go([pass("deadline", 1)])).n, 1);
  assert.equal((await go([pass("error", 1)])).n, 1);
});
