// Com's Lambda entry point (spec §6). Starts the comms worker first, with
// the accept deadline, runs ComCore until idle or the deadline, then stops.

import { WorkerComms } from "../../shared/src/comms-worker.ts";
import { ComCore } from "./com.ts";
import { cachedSecrets } from "./auth.ts";
import { abortableSleep } from "./mock.ts";
import { loadModelSecret, S3Store } from "./aws.ts";

export const MARGIN_MS = 60_000;

export interface WakeEvent {
  reason?: string;
}
export interface LambdaContext {
  getRemainingTimeInMillis(): number;
}

const log = (e: Record<string, unknown>) => console.log(JSON.stringify({ com: e }));

/** Accept only requests that finish before run end minus the margin. */
export function acceptDeadline(now: number, remainingMs: number, marginMs = MARGIN_MS): number {
  return now + remainingMs - marginMs;
}

export async function handler(event: WakeEvent = {}, context?: LambdaContext): Promise<{ handled: number; declined: number; exit: string }> {
  const now = Date.now();
  const remaining = context?.getRemainingTimeInMillis() ?? 15 * 60_000;
  let declined = 0;
  const comms = new WorkerComms("com", {
    comms: { acceptDeadlineAtMs: acceptDeadline(now, remaining) },
    log: (e) => {
      if (e.kind === "declined") declined++;
      log(e as unknown as Record<string, unknown>);
    },
  });
  log({ kind: "start", reason: typeof event?.reason === "string" ? event.reason : null });
  const bucket = process.env["BUCKET_NAME"] ?? "";
  const arn = process.env["MODEL_SECRET_ARN"] ?? "";
  const core = new ComCore({
    comms,
    store: new S3Store(bucket),
    secrets: cachedSecrets(() => loadModelSecret(arn)),
    fetch: globalThis.fetch,
    sleep: abortableSleep,
    now: Date.now,
    log,
    runEndsAtMs: now + remaining,
    delayScale: Number(process.env["MOCK_DELAY_SCALE"] ?? "1") || 1,
  });
  let exit = "error";
  try {
    exit = await core.run();
  } catch (e) {
    log({ kind: "run-failed", error: String(e) });
  } finally {
    await comms.stop().catch((e: unknown) => log({ kind: "stop-failed", error: String(e) }));
  }
  return { handled: core.handled, declined, exit };
}
