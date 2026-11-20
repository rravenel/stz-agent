import { test } from "node:test";
import assert from "node:assert/strict";
import { handler } from "./index.ts";

test("com stub handler answers with its name and the wake reason", async () => {
  assert.deepEqual(await handler({ reason: "wake" }), { stub: "com", reason: "wake" });
  assert.deepEqual(await handler(), { stub: "com", reason: null });
});
