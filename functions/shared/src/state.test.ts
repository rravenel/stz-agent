import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, markSeen } from "./state.ts";

test("initialState is empty and JSON-serialisable", () => {
  const s = initialState();
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  assert.equal(s.next_seq, 0);
});

test("markSeen dedupes and keeps only the most recent ids", () => {
  const s = initialState();
  assert.equal(markSeen(s, "a", 2), true);
  assert.equal(markSeen(s, "a", 2), false);
  markSeen(s, "b", 2);
  markSeen(s, "c", 2);
  assert.deepEqual(s.seen_msg_ids, ["b", "c"]);
  assert.equal(markSeen(s, "a", 2), true, "evicted ids are accepted again");
});
