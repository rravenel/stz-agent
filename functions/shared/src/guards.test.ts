import { test } from "node:test";
import assert from "node:assert/strict";
import { isNonEmptyString, isRecord } from "./guards.ts";

test("isRecord accepts plain objects only", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord("x"), false);
});

test("isNonEmptyString rejects empty and non-strings", () => {
  assert.equal(isNonEmptyString("a"), true);
  assert.equal(isNonEmptyString(""), false);
  assert.equal(isNonEmptyString(1), false);
});
