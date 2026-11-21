import { test } from "node:test";
import assert from "node:assert/strict";
import { formatEvent } from "./format.ts";
import { ev } from "./fake-doorman.ts";

test("(i) one line per kind", () => {
  assert.equal(formatEvent(ev(1, "user.message", { body: { text: "hi" } })), "you: hi");
  assert.equal(
    formatEvent(ev(2, "model.response", { body: { content: [{ type: "text", text: "ok" }, { type: "tool_call", name: "repl", input: { code: "a()\nb()" } }] } })),
    "ok → repl(a())",
  );
  assert.equal(formatEvent(ev(3, "tool.result", { body: { content: "x".repeat(300) } })).length, 2 + 200);
  assert.equal(formatEvent(ev(4, "tool.result", { body: { content: "bad", is_error: true } })), "← error: bad");
  assert.equal(formatEvent(ev(5, "http.request", { body: { purpose: "model", method: "POST", url: "mock://model" } })), "· com model POST mock://model");
  assert.equal(formatEvent(ev(6, "http.response", { body: { purpose: "repl", ok: true, status: 200, elapsed_ms: 1500 } })), "· com repl 200 1.5s");
  assert.equal(formatEvent(ev(7, "lifecycle", { body: { event: "exit_idle", reason: "idle" } })), "· prime exit_idle (idle)");
  assert.equal(formatEvent(ev(8, "error", { body: { message: "boom" } })), "! boom");
  assert.equal(formatEvent(ev(9, "conv.clear")), "· conv.clear");
});

test("ANSI dim only on a TTY", () => {
  const e = ev(1, "lifecycle", { body: { event: "checkpoint" } });
  assert.equal(formatEvent(e, false), "· prime checkpoint");
  assert.equal(formatEvent(e, true), "\x1b[2m· prime checkpoint\x1b[0m");
});
