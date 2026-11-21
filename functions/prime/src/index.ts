// Prime's Lambda entry point: the harness (handler.ts) wired to the real
// comms worker (SQS), S3 and the async self-wake.
//
// Nothing happens at import. The comms worker starts by re-executing this
// bundle in a worker thread (comms-worker.ts), and a config error must
// surface as a failed invocation, not a module that won't load. So the
// dependencies are built on the first invocation and reused for the life of
// the execution environment.

import { WorkerComms } from "../../shared/src/comms-worker.ts";
import type { Comms } from "../../shared/src/comms.ts";
import { S3ObjectStore } from "../../shared/src/s3-object-store.ts";
import { makeSelfWake } from "../../shared/src/self-wake.ts";
import { createHandler, type PrimeDeps, type RunSummary, type WakeEvent } from "./handler.ts";
import { adapterFromEnv } from "./models/config.ts";
import type { ObjectStore } from "./store.ts";

export { createHandler } from "./handler.ts";
export type { WakeEvent } from "./handler.ts";

/** How the real dependencies are made; tests pass fakes. */
export interface PrimeFactories {
  comms: () => Comms;
  store: (bucket: string) => ObjectStore;
  selfWake: (functionName: string) => (event: { reason: "continue" }) => Promise<void>;
}

export const awsFactories: PrimeFactories = {
  comms: () => new WorkerComms("prime"),
  store: (bucket) => new S3ObjectStore(bucket),
  selfWake: (fn) => makeSelfWake(fn),
};

const REQUIRED = ["BUCKET_NAME", "PRIME_FUNCTION_NAME"] as const;

/** Prime's dependencies from its environment (set by the stack). Throws one error naming everything missing. */
export function primeDepsFromEnv(env: Record<string, string | undefined>, make: PrimeFactories = awsFactories): PrimeDeps {
  const missing = REQUIRED.filter((k) => !env[k]?.trim());
  if (missing.length) throw new Error(`Prime is missing environment variables: ${missing.join(", ")}`);
  const adapter = adapterFromEnv(env); // throws with its own message on bad model config
  return {
    comms: () => make.comms(), // one worker per run: it starts first and is stopped before the run returns
    store: make.store(env["BUCKET_NAME"]!.trim()),
    adapter,
    selfWake: make.selfWake(env["PRIME_FUNCTION_NAME"]!.trim()),
  };
}

let real: ((event?: WakeEvent, context?: { awsRequestId?: string }) => Promise<RunSummary>) | undefined;

/** The Lambda handler. */
export async function handler(event: WakeEvent = {}, context: { awsRequestId?: string } = {}): Promise<RunSummary> {
  real ??= createHandler(primeDepsFromEnv(process.env));
  return real(event, context);
}
