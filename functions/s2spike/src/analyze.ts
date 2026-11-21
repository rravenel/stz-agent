// Spike S2 (issue #0004): turn the driver's raw observations into a Report.
// Pure: no AWS, so it is unit-tested; index.ts gathers the raw data.

import type { WakeResult } from "../../shared/src/comms-core.ts";

export type TargetMode = "ping" | "sleep" | "selfwake" | "continued";

/** What the target writes to s3://<bucket>/spikes/s2/<id>.json (ms epoch). */
export interface Marker {
  id: string;
  mode: TargetMode;
  cold: boolean;
  initAt: number;
  startAt: number;
  endAt: number;
}

/** The raw error fields of a failed Invoke, as the SDK reports them. */
export interface RawError {
  name?: string;
  reason?: string;
  httpStatus?: number;
}

export interface TimedCall {
  /** When the driver sent the Invoke (ms epoch). */
  callStartAt: number;
  durationMs: number;
  result: WakeResult;
  error?: RawError;
  /** The target's {cold} reply, for pings that returned. */
  cold?: boolean;
}

export interface Raw {
  pings: [TimedCall, TimedCall];
  /** sleep {ms:10000} with a 2 s abort. */
  sleepCall: TimedCall;
  /** ping sent right after sleepCall, no abort. */
  busyCall: TimedCall;
  sleepMarker: Marker | null;
  selfwakeParent: Marker | null;
  selfwakeContinued: Marker | null;
}

export interface Report {
  check1: { secondCall: WakeResult; errorName: string | null; reason: string | null; httpStatus: number | null; pass: boolean };
  check2: { firstCall: WakeResult; markerFound: boolean; markerEndMinusCallStartMs: number | null; pass: boolean };
  check3: { gapMs: number | null; pass: boolean };
  init: { coldInvokeMs: number; warmInvokeMs: number; coldFlagSeen: boolean };
  verdict: string;
}

export const CHECK2_MIN_MS = 8000;
export const CHECK2_MAX_MS = 15000;
export const CHECK3_MAX_GAP_MS = 10000;

export function summarize(raw: Raw): Report {
  const busy = raw.busyCall;
  const check1 = {
    secondCall: busy.result,
    errorName: busy.error?.name ?? null,
    reason: busy.error?.reason ?? null,
    httpStatus: busy.error?.httpStatus ?? null,
    pass: busy.result.kind === "running",
  };

  const m = raw.sleepMarker;
  const delta = m ? m.endAt - raw.sleepCall.callStartAt : null;
  const check2 = {
    firstCall: raw.sleepCall.result,
    markerFound: m !== null,
    markerEndMinusCallStartMs: delta,
    pass: raw.sleepCall.result.kind === "started" && delta !== null && delta >= CHECK2_MIN_MS && delta <= CHECK2_MAX_MS,
  };

  const p = raw.selfwakeParent;
  const c = raw.selfwakeContinued;
  const gap = p && c ? c.startAt - p.endAt : null;
  const check3 = { gapMs: gap, pass: gap !== null && gap < CHECK3_MAX_GAP_MS };

  const [first, second] = raw.pings;
  const init = { coldInvokeMs: first.durationMs, warmInvokeMs: second.durationMs, coldFlagSeen: first.cold === true };

  const failing = (["check1", "check2", "check3"] as const).filter((k) => !{ check1, check2, check3 }[k].pass);
  return { check1, check2, check3, init, verdict: failing.length ? failing.join(", ") : "all pass" };
}
