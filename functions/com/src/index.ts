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

export interface PassResult {
  exit: string;
  released: number;
  handled: number;
}

/**
 * A request acked between the final poll and stop() is released, but Prime
 * has seen its ack and won't wake Com for it (#0034): go round again with a
 * new comms worker. Only after a normal exit, and while there is time.
 */
export async function runUntilDrained(runOnce: () => Promise<PassResult>, hasTime: () => boolean): Promise<PassResult> {
  let handled = 0;
  for (;;) {
    const r = await runOnce();
    handled += r.handled;
    if (r.released === 0 || r.exit !== "idle" || !hasTime()) return { ...r, handled };
  }
}

export async function handler(event: WakeEvent = {}, context?: LambdaContext): Promise<{ handled: number; declined: number; exit: string }> {
  const now = Date.now();
  const remaining = context?.getRemainingTimeInMillis() ?? 15 * 60_000;
  let declined = 0;
  log({ kind: "start", reason: typeof event?.reason === "string" ? event.reason : null });
  const bucket = process.env["BUCKET_NAME"] ?? "";
  const arn = process.env["MODEL_SECRET_ARN"] ?? "";
  const secrets = cachedSecrets(() => loadModelSecret(arn));
  const store = new S3Store(bucket);
  const seen = new Set<string>();
  const runOnce = async (): Promise<PassResult> => {
    const comms = new WorkerComms("com", {
      comms: { acceptDeadlineAtMs: acceptDeadline(now, remaining) },
      log: (e) => {
        if (e.kind === "declined") declined++;
        log(e as unknown as Record<string, unknown>);
      },
    });
    const core = new ComCore({
      comms,
      store,
      secrets,
      seen,
      fetch: globalThis.fetch,
      sleep: abortableSleep,
      now: Date.now,
      log,
      runEndsAtMs: now + remaining,
      delayScale: Number(process.env["MOCK_DELAY_SCALE"] ?? "1") || 1,
    });
    let exit = "error";
    let released = 0;
    try {
      exit = await core.run();
    } catch (e) {
      log({ kind: "run-failed", error: String(e) });
    } finally {
      await comms.stop().then(
        (r) => (released = r.released),
        (e: unknown) => log({ kind: "stop-failed", error: String(e) }),
      );
    }
    return { exit, released, handled: core.handled };
  };
  const r = await runUntilDrained(runOnce, () => now + remaining - Date.now() > 2 * MARGIN_MS);
  return { handled: r.handled, declined, exit: r.exit };
}
