// AWS adapters for the comms ports (protocol §4.1, §6).
//
// TODO(#0005): SqsQueuePort, LambdaWakePort and fromEnv() need
// @aws-sdk/client-sqs and @aws-sdk/client-lambda, which aren't installed yet
// (see issues/0005.md, Prerequisites). Until then only the pure classifier
// ships, so it can be tested without the SDK.

import type { WakeResult } from "./comms-core.ts";

/** The parts of a Lambda Invoke result or error the classifier looks at. */
export type InvokeOutcome =
  | { ok: true; StatusCode?: number; FunctionError?: string }
  | { ok: false; error: unknown };

/**
 * Classify a sync-wake Invoke (protocol §4.1):
 * abort → started (the target is starting and outlived our 2 s budget);
 * 429 / TooManyRequestsException → running; FunctionError → failed;
 * any other error → error; a normal fast return → started.
 */
export function classifyInvoke(o: InvokeOutcome): WakeResult {
  if (o.ok) {
    if (o.FunctionError) return { kind: "failed", detail: o.FunctionError };
    return { kind: "started", detail: `status ${o.StatusCode ?? "?"}` };
  }
  const e = (o.error ?? {}) as { name?: unknown; Reason?: unknown; message?: unknown; $metadata?: { httpStatusCode?: unknown } };
  const name = typeof e.name === "string" ? e.name : "";
  if (name === "AbortError" || name === "TimeoutError") return { kind: "started", detail: "aborted" };
  if (name === "TooManyRequestsException" || e.$metadata?.httpStatusCode === 429) {
    return { kind: "running", detail: typeof e.Reason === "string" ? e.Reason : "429" };
  }
  return { kind: "error", detail: name || (typeof e.message === "string" ? e.message : String(o.error)) };
}
