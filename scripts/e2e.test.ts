import { test } from "node:test";
import assert from "node:assert/strict";
import { apiUrlFromOutputs, checkTurn, formatChecks, formatTimeline, parseCli, type Ev } from "./e2e.ts";

const M = "msg-1";
let seq = 0;
const ev = (run: string, s: number, kind: string, extra: Partial<Ev> = {}): Ev => ({
  seq: seq++,
  ts: new Date(Date.UTC(2026, 10, 21, 0, 0, s)).toISOString(),
  run,
  kind,
  ...extra,
});

function passing(): Ev[] {
  seq = 10;
  return [
    ev("r1", 0, "lifecycle", { body: { event: "start", reason: "prewake" } }),
    ev("r1", 1, "user.message", { msg_id: M, body: { text: "hi" } }),
    ev("r1", 2, "model.request", { corr_id: "q1" }),
    ev("r1", 3, "lifecycle", { body: { event: "exit_idle", pending_requests: 1, open_tool_calls: 0 } }),
    ev("r2", 63, "lifecycle", { body: { event: "start", reason: "wake" } }),
    ev("r2", 64, "model.response", { corr_id: "q1", body: { stop: "end_turn" } }),
  ];
}

test("checkTurn: a good timeline passes every check", () => {
  const r = checkTurn(passing().reverse(), M);
  assert.equal(r.pass, true, formatChecks(r));
  assert.deepEqual(r.checks.map((c) => c.seq), [11, 13, 14, 15]);
  assert.equal(r.info.runs, 2);
  assert.equal(r.info.sleepToWakeMs, 60_000);
  assert.equal(r.info.wallClockMs, 63_000);
  assert.match(formatChecks(r), /E2E PASS/);
});

test("checkTurn: each check fails on its own", () => {
  const drop = (i: number) => passing().filter((_, j) => j !== i);
  const failing = (evs: Ev[]) => checkTurn(evs, M).checks.filter((c) => !c.pass).map((c) => c.name[0]);
  assert.deepEqual(failing(drop(5)), ["d"]);
  assert.deepEqual(failing(drop(4)), ["c", "d"]);
  const noPending = passing();
  noPending[3]!.body = { event: "exit_idle", pending_requests: 0 };
  assert.deepEqual(failing(noPending), ["b", "c", "d"]);
  const sameRun = passing();
  sameRun[4]!.run = "r1";
  assert.deepEqual(failing(sameRun), ["c", "d"]);
  const notEnd = passing();
  notEnd[5]!.body = { stop: "tool_use" };
  assert.deepEqual(failing(notEnd), ["d"]);
});

test("checkTurn: another msg_id doesn't count", () => {
  const r = checkTurn(passing(), "other");
  assert.equal(r.pass, false);
  assert.equal(r.checks[0]!.pass, false);
  assert.match(formatChecks(r), /E2E FAIL/);
});

test("formatTimeline: one line per event", () => {
  const out = formatTimeline(passing());
  assert.equal(out.split("\n").length, 6);
  assert.match(out, /exit_idle/);
});

test("parseCli: defaults and errors", () => {
  assert.deepEqual(parseCli(["--env", "rene"]).outputs, "cdk.out/outputs-rene.json");
  assert.equal(parseCli(["--env", "rene", "--timeout", "30"]).timeoutS, 30);
  assert.throws(() => parseCli([]), /--env/);
  assert.throws(() => parseCli(["--env", "x", "--timeout", "-1"]), /timeout/);
  assert.equal(parseCli(["-h"]).help, true);
});

test("apiUrlFromOutputs reads the stack's ApiUrl", () => {
  const j = JSON.stringify({ "StzAgent-rene": { ApiUrl: "https://x.example/", BucketName: "b" } });
  assert.equal(apiUrlFromOutputs(j, "rene"), "https://x.example");
  assert.throws(() => apiUrlFromOutputs(j, "other"), /no ApiUrl/);
});
