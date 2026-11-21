import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize, type Marker, type Raw } from "./analyze.ts";

const T0 = 1_000_000;

function marker(id: string, mode: Marker["mode"], startAt: number, endAt: number): Marker {
  return { id, mode, cold: false, initAt: T0, startAt, endAt };
}

function passing(): Raw {
  return {
    pings: [
      { callStartAt: T0, durationMs: 450, result: { kind: "started" }, cold: true },
      { callStartAt: T0 + 500, durationMs: 30, result: { kind: "started" }, cold: false },
    ],
    sleepCall: { callStartAt: T0 + 1000, durationMs: 2000, result: { kind: "started", detail: "aborted" } },
    busyCall: {
      callStartAt: T0 + 3000,
      durationMs: 40,
      result: { kind: "running", detail: "ReservedFunctionConcurrentInvocationLimitExceeded" },
      error: { name: "TooManyRequestsException", reason: "ReservedFunctionConcurrentInvocationLimitExceeded", httpStatus: 429 },
    },
    sleepMarker: marker("s", "sleep", T0 + 1100, T0 + 11100),
    selfwakeParent: marker("w", "selfwake", T0 + 20000, T0 + 20100),
    selfwakeContinued: marker("w-continued", "continued", T0 + 21500, T0 + 21600),
  };
}

test("summarize: all checks pass on a good run", () => {
  const r = summarize(passing());
  assert.equal(r.verdict, "all pass");
  assert.equal(r.check1.errorName, "TooManyRequestsException");
  assert.equal(r.check1.httpStatus, 429);
  assert.equal(r.check2.markerEndMinusCallStartMs, 10100);
  assert.equal(r.check3.gapMs, 1400);
  assert.deepEqual(r.init, { coldInvokeMs: 450, warmInvokeMs: 30, coldFlagSeen: true });
});

test("summarize: no 429 on the second call fails check1", () => {
  const raw = passing();
  raw.busyCall = { callStartAt: T0 + 3000, durationMs: 30, result: { kind: "started", detail: "status 200" } };
  const r = summarize(raw);
  assert.equal(r.check1.pass, false);
  assert.equal(r.check1.errorName, null);
  assert.equal(r.verdict, "check1");
});

test("summarize: missing sleep marker fails check2", () => {
  const raw = passing();
  raw.sleepMarker = null;
  const r = summarize(raw);
  assert.equal(r.check2.markerFound, false);
  assert.equal(r.check2.pass, false);
  assert.equal(r.verdict, "check2");
});

test("summarize: a marker far outside 10 s fails check2", () => {
  const raw = passing();
  raw.sleepMarker = marker("s", "sleep", T0 + 1100, T0 + 1100 + 3000);
  assert.equal(summarize(raw).check2.pass, false);
});

test("summarize: a 25 s self-wake gap fails check3", () => {
  const raw = passing();
  raw.selfwakeContinued = marker("w-continued", "continued", T0 + 20100 + 25000, T0 + 45200);
  const r = summarize(raw);
  assert.equal(r.check3.gapMs, 25000);
  assert.equal(r.check3.pass, false);
});

test("summarize: verdict lists every failing check", () => {
  const raw = passing();
  raw.busyCall.result = { kind: "error", detail: "x" };
  raw.selfwakeContinued = null;
  assert.equal(summarize(raw).verdict, "check1, check3");
});
