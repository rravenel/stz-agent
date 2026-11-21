// Spike S2 (issue #0004): one bundle, two functions.
// Target modes (ping/sleep/selfwake/continued) run in <stack>-s2-target
// (reserved concurrency 1); mode "drive" runs in <stack>-s2-driver and
// exercises the target with the production client config and classifier.

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { classifyInvoke, type InvokeOutcome } from "../../shared/src/aws-ports.ts";
import { summarize, type Marker, type RawError, type Report, type TargetMode, type TimedCall } from "./analyze.ts";

const initAt = Date.now();
let cold = true;

const lambda = new LambdaClient({ maxAttempts: 1 });
const s3 = new S3Client({});

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

const key = (id: string) => `spikes/s2/${id}.json`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function putMarker(id: string, mode: TargetMode, wasCold: boolean, startAt: number): Promise<Marker> {
  const m: Marker = { id, mode, cold: wasCold, initAt, startAt, endAt: Date.now() };
  await s3.send(new PutObjectCommand({ Bucket: env("SPIKE_BUCKET"), Key: key(id), Body: JSON.stringify(m), ContentType: "application/json" }));
  return m;
}

async function getMarker(id: string): Promise<Marker | null> {
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: env("SPIKE_BUCKET"), Key: key(id) }));
    return JSON.parse((await out.Body?.transformToString()) ?? "null") as Marker | null;
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name === "NoSuchKey" || name === "AccessDenied") return null;
    throw e;
  }
}

async function pollMarker(id: string, timeoutMs: number): Promise<Marker | null> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const m = await getMarker(id);
    if (m || Date.now() >= until) return m;
    await sleep(1000);
  }
}

function rawError(e: unknown): RawError {
  const x = (e ?? {}) as { name?: unknown; Reason?: unknown; $metadata?: { httpStatusCode?: unknown } };
  const out: RawError = {};
  if (typeof x.name === "string") out.name = x.name;
  if (typeof x.Reason === "string") out.reason = x.Reason;
  if (typeof x.$metadata?.httpStatusCode === "number") out.httpStatus = x.$metadata.httpStatusCode;
  return out;
}

/** Sync-invoke the target, optionally aborting after abortMs (protocol §4.1). */
async function call(payload: object, abortMs?: number): Promise<TimedCall> {
  const callStartAt = Date.now();
  const opts = abortMs === undefined ? {} : { abortSignal: AbortSignal.timeout(abortMs) };
  let outcome: InvokeOutcome;
  let replyCold: boolean | undefined;
  let error: RawError | undefined;
  try {
    const out = await lambda.send(
      new InvokeCommand({ FunctionName: env("TARGET_FUNCTION_NAME"), InvocationType: "RequestResponse", Payload: JSON.stringify(payload) }),
      opts,
    );
    outcome = { ok: true, StatusCode: out.StatusCode, FunctionError: out.FunctionError };
    if (out.Payload) {
      const body = JSON.parse(Buffer.from(out.Payload).toString("utf8")) as { cold?: unknown } | null;
      if (typeof body?.cold === "boolean") replyCold = body.cold;
    }
  } catch (e) {
    outcome = { ok: false, error: e };
    error = rawError(e);
  }
  const t: TimedCall = { callStartAt, durationMs: Date.now() - callStartAt, result: classifyInvoke(outcome) };
  if (error) t.error = error;
  if (replyCold !== undefined) t.cold = replyCold;
  return t;
}

async function drive(): Promise<Report> {
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // (a) cold then warm ping.
  const ping1 = await call({ mode: "ping" });
  const ping2 = await call({ mode: "ping" });
  // (b) start a 10 s sleep, give up at 2 s, then hit the busy target at once.
  const sleepId = `${run}-sleep`;
  const sleepCall = await call({ mode: "sleep", id: sleepId, ms: 10000 }, 2000);
  const busyCall = await call({ mode: "ping" });
  // (c) the sleeper should finish anyway.
  const sleepMarker = await pollMarker(sleepId, 20000);
  // (d) self-wake: parent marker now, continued marker after the async invoke lands.
  const wakeId = `${run}-wake`;
  await call({ mode: "selfwake", id: wakeId });
  const selfwakeContinued = await pollMarker(`${wakeId}-continued`, 60000);
  const selfwakeParent = await getMarker(wakeId);
  return summarize({ pings: [ping1, ping2], sleepCall, busyCall, sleepMarker, selfwakeParent, selfwakeContinued });
}

interface Event {
  mode?: string;
  id?: string;
  ms?: number;
}

export async function handler(event: Event): Promise<unknown> {
  const startAt = Date.now();
  const wasCold = cold;
  cold = false;
  const id = event.id ?? `${startAt}`;
  switch (event.mode) {
    case "ping":
      return { cold: wasCold };
    case "sleep":
      await sleep(event.ms ?? 10000);
      return putMarker(id, "sleep", wasCold, startAt);
    case "selfwake": {
      const m = await putMarker(id, "selfwake", wasCold, startAt);
      // Last action: async self-invoke (protocol §4.2 continue).
      await lambda.send(
        new InvokeCommand({
          FunctionName: env("SELF_FUNCTION_NAME"),
          InvocationType: "Event",
          Payload: JSON.stringify({ mode: "continued", id: `${id}-continued` }),
        }),
      );
      return m;
    }
    case "continued":
      return putMarker(id, "continued", wasCold, startAt);
    case "drive":
      return drive();
    default:
      throw new Error(`unknown mode ${String(event.mode)}`);
  }
}
