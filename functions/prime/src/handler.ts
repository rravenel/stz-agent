// Prime's handler flow (spec §5.1, §5.5; protocol §4.2, §7.3, §8), with its
// dependencies injected so tests run it against fakes. Real wiring (the SQS
// comms worker, S3, the self-invoke) happens in #0008.

import { randomUUID } from "node:crypto";
import type { Comms, Delivery } from "../../shared/src/comms.ts";
import { markSeen } from "../../shared/src/state.ts";
import { loadCheckpoint, peekState, saveCheckpoint } from "./checkpoint.ts";
import { LogWriter } from "./log.ts";
import { Harness } from "./loop.ts";
import type { ModelAdapter } from "./models/turn.ts";
import { Proxy } from "./proxy.ts";
import type { FetchRequest, ReplOptions } from "./repl/repl.ts";
import type { ObjectStore } from "./store.ts";

export const STALE_WAKE_MS = 1_000;
export const IDLE_GRACE_MS = 2_000;
export const RUN_DEADLINE_MS = 12 * 60_000;
export const HARD_STOP_MS = 14 * 60_000;
export const ACK_POLL_MS = 50;
/** After the deadline, absorb inbound work only while this much time is left before the hard stop (one eval's CPU limit, plus margin). */
const ABSORB_MARGIN_MS = 60_000;

export interface WakeEvent {
  reason?: string;
}

export interface PrimeDeps {
  /** Start this run's comms worker (it starts polling and acking at once). */
  comms: () => Comms;
  store: ObjectStore;
  adapter: ModelAdapter;
  /** Async self-invoke (`InvocationType: "Event"`) for the continuation (protocol §4.2). */
  selfWake?: (event: { reason: "continue" }) => Promise<void>;
  replOptions?: Omit<ReplOptions, "onFetch">;
  system?: string;
  maxTokens?: number;
  /** Wait for a first non-ack message before treating the wake as stale (spec §5.1 step 3). */
  staleWakeMs?: number;
  /** Final-poll grace before exit (spec §5.5 step 6). */
  idleGraceMs?: number;
  /** Run time after which Prime stops starting work and continues in a new run (spec §5.5). */
  runDeadlineMs?: number;
  /** Past this, stop waiting for acks: better a checkpoint than a Lambda timeout mid-write. */
  hardStopMs?: number;
  ackPollMs?: number;
  now?: () => Date;
}

export type ExitReason = "idle" | "deadline" | "stale_wake";

export interface RunSummary {
  run: string;
  exit: ExitReason;
  restored: boolean;
  processed: number;
  duplicates: number;
  checkpoint: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const tick = () => new Promise<void>((r) => setImmediate(r));

export function createHandler(deps: PrimeDeps) {
  const staleWakeMs = deps.staleWakeMs ?? STALE_WAKE_MS;
  const idleGraceMs = deps.idleGraceMs ?? IDLE_GRACE_MS;
  const runDeadlineMs = deps.runDeadlineMs ?? RUN_DEADLINE_MS;
  const hardStopMs = deps.hardStopMs ?? HARD_STOP_MS;
  const ackPollMs = deps.ackPollMs ?? ACK_POLL_MS;

  return async function handler(event: WakeEvent = {}, context: { awsRequestId?: string } = {}): Promise<RunSummary> {
    const run = context.awsRequestId ?? randomUUID();
    const now = deps.now ?? (() => new Date());
    const startedAt = now().getTime();
    const elapsed = () => now().getTime() - startedAt;
    const isContinue = event.reason === "continue";

    // 1–2. Comms worker first: acks flow before (and during) the restore.
    const comms = deps.comms();
    const inbox: Delivery[] = [];
    comms.onMessage((d) => inbox.push(d));

    try {
      // 3. Stale-wake check: no message, and not a continuation (a prewake
      // takes this path on purpose). Return without restoring.
      if (!isContinue) {
        const until = Date.now() + staleWakeMs;
        await tick();
        while (inbox.length === 0 && Date.now() < until) await sleep(Math.min(10, staleWakeMs));
        if (inbox.length === 0) {
          const peek = await peekState(deps.store);
          const log = new LogWriter(deps.store, run, peek, now);
          await log.lifecycle("stale_wake", { reason: event.reason ?? null, waited_ms: staleWakeMs });
          return { run, exit: "stale_wake", restored: false, processed: 0, duplicates: 0, checkpoint: peek.n };
        }
      }

      // 4. Restore.
      const outbox: FetchRequest[] = [];
      const { state, repl, restored, workspace, workspaceSkipped } = await loadCheckpoint(deps.store, {
        ...deps.replOptions,
        onFetch: (r) => outbox.push(r),
      });
      const log = new LogWriter(deps.store, run, state, now);
      await log.lifecycle("start", { reason: event.reason ?? null });
      if (restored) {
        await log.lifecycle("restore", {
          n: state.n,
          workspace_files: workspace.manifest.size,
          ...(workspaceSkipped.length ? { workspace_skipped: workspaceSkipped } : {}),
        });
      }

      const proxy = new Proxy(deps.store, comms, log, state, now);
      const harness = new Harness({
        state, repl, outbox, adapter: deps.adapter, proxy, log, run,
        ...(deps.system !== undefined ? { system: deps.system } : {}),
        ...(deps.maxTokens !== undefined ? { maxTokens: deps.maxTokens } : {}),
      });

      const held: string[] = [];
      let processed = 0;
      let duplicates = 0;
      let continuing = false;

      const pastDeadline = () => {
        if (!continuing && elapsed() >= runDeadlineMs) continuing = true;
        return continuing;
      };
      /** Process everything buffered. Before the deadline the turn advances; after it, inbound work is only absorbed. */
      const drain = async () => {
        await tick();
        while (inbox.length) {
          if (pastDeadline() && elapsed() >= hardStopMs - ABSORB_MARGIN_MS) return; // left in SQS for the next run
          const { msg, receipt } = inbox.shift()!;
          held.push(receipt);
          if (!markSeen(state, msg.msg_id)) {
            duplicates++;
            continue;
          }
          processed++;
          if (msg.type === "user.message") await harness.onUserMessage(msg);
          else if (msg.type === "http.response") await harness.onHttpResponse(msg);
          else await log.append("error", { msg_id: msg.msg_id, body: { where: "inbound", message: `unexpected ${msg.type}` } });
          if (!pastDeadline()) await harness.step();
        }
        if (!pastDeadline()) await harness.step();
      };

      // Responses already waiting count before anything is declared lost (#0015 review).
      await drain();
      await harness.failStale(now());
      if (!pastDeadline()) await harness.step();

      for (;;) {
        // Checklist step 1: harness idle (spec §5.5).
        await drain();
        // Step 2: REPL quiescent. Evals are synchronous and drain their job
        // queue before returning, so between calls this always holds.
        if (repl.busy) throw new Error("REPL busy at exit");
        // Step 3: Com has acked every outbound request. Inbound messages
        // that arrive while waiting go back to step 1.
        let backToIdle = false;
        while (comms.unackedCount() > 0) {
          if (inbox.length && !(pastDeadline() && elapsed() >= hardStopMs - ABSORB_MARGIN_MS)) {
            backToIdle = true;
            break;
          }
          if (elapsed() >= hardStopMs) {
            await log.append("error", { body: { where: "exit", message: "outbound still unacked at the hard stop", unacked: comms.unackedCount() } });
            break;
          }
          await sleep(ackPollMs);
        }
        if (backToIdle) continue;
        // Steps 4–5: checkpoint durable, then delete what it covers.
        await saveCheckpoint(deps.store, state, repl, log, workspace);
        for (const r of held.splice(0)) await comms.deleteMessage(r);

        if (pastDeadline()) {
          // Continuation (spec §5.5): the self-wake is the very last action.
          await log.lifecycle("exit_deadline", { elapsed_ms: elapsed(), runnable: harness.runnable() });
          if (!deps.selfWake) throw new Error("run deadline reached but no selfWake is configured");
          await deps.selfWake({ reason: "continue" });
          return { run, exit: "deadline", restored, processed, duplicates, checkpoint: state.n };
        }
        // Step 6: final poll. A message goes back to step 1.
        const empty = await comms.finalPoll(idleGraceMs);
        if (empty && inbox.length === 0) {
          await log.lifecycle("exit_idle", { open_tool_calls: state.open_tool_calls.length, pending_requests: Object.keys(state.pending_requests).length });
          return { run, exit: "idle", restored, processed, duplicates, checkpoint: state.n };
        }
      }
    } finally {
      await comms.stop();
    }
  };
}
