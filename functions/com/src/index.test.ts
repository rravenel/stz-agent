import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptDeadline, MARGIN_MS } from "./index.ts";

test("acceptDeadline: run end minus a 60 s margin", () => {
  assert.equal(MARGIN_MS, 60_000);
  assert.equal(acceptDeadline(1_000, 900_000), 1_000 + 900_000 - 60_000);
});
