import { test } from "node:test";
import assert from "node:assert/strict";
import { handler } from "./index.ts";

test("prime stub handler answers with its name and the wake reason", async () => {
  assert.deepEqual(await handler({ reason: "wake" }), { stub: "prime", reason: "wake" });
  assert.deepEqual(await handler(), { stub: "prime", reason: null });
});
