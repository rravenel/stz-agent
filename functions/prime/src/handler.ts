// Prime's handler flow (spec §5.1, §5.5; protocol §4.2, §7.3, §8), with its
// dependencies injected so tests run it against fakes. Real wiring (the SQS
// comms worker, S3, the self-invoke) happens in #0008.

import { randomUUID } from "node:crypto";
import type { Comms, Delivery, StopResult } from "../../shared/src/comms.ts";
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

/**
 * The run's comms, restartable. Stopping the worker awaits its in-flight
 * long poll, and a message that poll receives is acked and handed over
 * *after* the run decided to exit (#0029). The sender then sees the ack and
 * wakes nobody, so the run must not leave it behind: when the inbox isn't
 * empty after stop(), the handler restarts comms here and keeps going.
 * stop() is idempotent (a WorkerComms can't be stopped twice).
 */
class RunComms implements Comms {
  private cur: Comms;
  private stopped = false;
  private last: StopResult = { released: 0 };
  private handler: ((d: Delivery) => void) | null = null;
  private readonly make: () => Comms;

  constructor(make: () => Comms) {
    this.make = make;
    this.cur = make();
  }
  get self() {
    return this.cur.self;
  }
  send: Comms["send"] = (to, type, body, opts) => this.cur.send(to, type, body, opts);
  onMessage(h: (d: Delivery) => void): void {
    this.handler = h;
    this.cur.onMessage(h);
  }
  /** Receipts are per queue, not per consumer: a restarted worker can delete an earlier one's messages. */
  deleteMessage(receipt: string): Promise<void> {
    return this.cur.deleteMessage(receipt);
  }
  unackedCount(): number {
    return this.cur.unackedCount();
  }
  finalPoll(graceMs: number): Promise<boolean> {
    return this.cur.finalPoll(graceMs);
  }
  release(receipt: string): Promise<void> {
    return this.cur.release(receipt);
  }
  /** Idempotent: repeated calls report the same result until restart(). */
  async stop(): Promise<StopResult> {
    if (!this.stopped) {
      this.stopped = true;
      this.last = { released: 0 };
      this.last = await this.cur.stop();
    }
    return this.last;
  }
  restart(): void {
    if (!this.stopped) return;
    this.cur = this.make();
    this.stopped = false;
    if (this.handler) this.cur.onMessage(this.handler);
  }
}
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
    const comms = new RunComms(deps.comms);
    const inbox: Delivery[] = [];
    comms.onMessage((d) => inbox.push(d));
    /** Set once this run has sent its self-wake, so it never sends two. */
    let woke = false;
    const selfWake = async () => {
      if (!deps.selfWake) throw new Error("messages or work left for a next run but no selfWake is configured");
      woke = true;
      await deps.selfWake({ reason: "continue" });
    };
    /** Released messages were acked, so nobody else will wake Prime for them (#0029). */
    const wakeIfReleased = async () => {
      if (!woke && (await comms.stop()).released > 0) await selfWake();
    };

    try {
      // 3. Stale-wake check: no message, and not a continuation (a prewake
      // takes this path on purpose). Return without restoring.
      if (!isContinue) {
        const until = Date.now() + staleWakeMs;
        await tick();
        while (inbox.length === 0 && Date.now() < until) await sleep(Math.min(10, staleWakeMs));
        // Stop before deciding: the worker's in-flight poll may still hand over a message.
        if (inbox.length === 0) await comms.stop();
        if (inbox.length > 0) comms.restart();
        else {
          const peek = await peekState(deps.store);
          const log = new LogWriter(deps.store, run, peek, now);
          await log.lifecycle("stale_wake", { reason: event.reason ?? null, waited_ms: staleWakeMs });
          await wakeIfReleased();
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
          if (inbox.length) {
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

        // Exit (#0029): stop the worker, then make sure its last poll left nothing.
        const exitNow = async () => {
          await comms.stop();
          if (inbox.length === 0) return true;
          comms.restart();
          return false;
        };
        if (pastDeadline()) {
          if (!(await exitNow())) continue;
          // Continuation (spec §5.5): the self-wake is the very last action.
          await log.lifecycle("exit_deadline", { elapsed_ms: elapsed(), runnable: harness.runnable() });
          await selfWake();
          return { run, exit: "deadline", restored, processed, duplicates, checkpoint: state.n };
        }
        // Step 6: final poll. A message goes back to step 1.
        const empty = await comms.finalPoll(idleGraceMs);
        if (empty && inbox.length === 0) {
          if (!(await exitNow())) continue;
          await log.lifecycle("exit_idle", { open_tool_calls: state.open_tool_calls.length, pending_requests: Object.keys(state.pending_requests).length });
          await wakeIfReleased();
          return { run, exit: "idle", restored, processed, duplicates, checkpoint: state.n };
        }
      }
    } catch (e) {
      // The crash path: stop() makes what this run received visible again. The
      // queue's maxReceiveCount bounds the retries. Never mask the real error.
      await wakeIfReleased().catch((e2: unknown) => console.error(JSON.stringify({ kind: "wake-failed", error: String(e2) })));
      throw e;
    } finally {
      await comms.stop();
    }
  };
}
