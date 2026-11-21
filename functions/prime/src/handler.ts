// Prime's handler flow (spec §5.1), with its dependencies injected so tests
// run it against fakes. Real wiring (the SQS comms worker from #0005, S3)
// happens in #0008. The stale-wake check, the full exit checklist and the
// 12-minute continuation are #0016; checkpoint hardening is #0015.

import { randomUUID } from "node:crypto";
import type { Comms, Delivery } from "../../shared/src/comms.ts";
import { markSeen } from "../../shared/src/state.ts";
import { loadCheckpoint, saveCheckpoint } from "./checkpoint.ts";
import { LogWriter } from "./log.ts";
import { Harness } from "./loop.ts";
import type { ModelAdapter } from "./models/turn.ts";
import { Proxy } from "./proxy.ts";
import type { FetchRequest, ReplOptions } from "./repl/repl.ts";
import type { ObjectStore } from "./store.ts";

export const IDLE_GRACE_MS = 2_000;

export interface WakeEvent {
  reason?: string;
}

export interface PrimeDeps {
  /** Start this run's comms worker (it starts polling and acking at once). */
  comms: () => Comms;
  store: ObjectStore;
  adapter: ModelAdapter;
  replOptions?: Omit<ReplOptions, "onFetch">;
  system?: string;
  maxTokens?: number;
  /** Final-poll grace before exit (spec §5.5 step 6). */
  idleGraceMs?: number;
  now?: () => Date;
}

export interface RunSummary {
  run: string;
  restored: boolean;
  processed: number;
  duplicates: number;
  checkpoint: number;
}

const tick = () => new Promise<void>((r) => setImmediate(r));

export function createHandler(deps: PrimeDeps) {
  return async function handler(event: WakeEvent = {}, context: { awsRequestId?: string } = {}): Promise<RunSummary> {
    const run = context.awsRequestId ?? randomUUID();
    const now = deps.now ?? (() => new Date());

    // 1–2. Comms worker first: acks flow before (and during) the restore.
    const comms = deps.comms();
    const inbox: Delivery[] = [];
    comms.onMessage((d) => inbox.push(d));

    try {
      // 3. Stale-wake check: #0016.
      // 4. Restore.
      const outbox: FetchRequest[] = [];
      const { state, repl, restored } = await loadCheckpoint(deps.store, {
        ...deps.replOptions,
        onFetch: (r) => outbox.push(r),
      });
      const log = new LogWriter(deps.store, run, state, now);
      await log.lifecycle("start", { reason: event.reason ?? null });
      if (restored) await log.lifecycle("restore", { n: state.n });

      const proxy = new Proxy(deps.store, comms, log, state, now);
      const harness = new Harness({
        state, repl, outbox, adapter: deps.adapter, proxy, log,
        ...(deps.system !== undefined ? { system: deps.system } : {}),
        ...(deps.maxTokens !== undefined ? { maxTokens: deps.maxTokens } : {}),
      });

      const held: string[] = [];
      let processed = 0;
      let duplicates = 0;
      for (;;) {
        // 5. Drain and run.
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
          await harness.step();
        }
        await harness.step();

        // 6. Minimal exit (full checklist: #0016): checkpoint, then delete
        // what it covers, then a final poll. A message in the final poll goes
        // back round the loop.
        await saveCheckpoint(deps.store, state, repl, log);
        for (const r of held.splice(0)) await comms.deleteMessage(r);
        const empty = await comms.finalPoll(deps.idleGraceMs ?? IDLE_GRACE_MS);
        if (empty && inbox.length === 0) {
          await log.lifecycle("exit_idle", { open_tool_calls: state.open_tool_calls.length, pending_requests: Object.keys(state.pending_requests).length });
          return { run, restored, processed, duplicates, checkpoint: state.n };
        }
      }
    } finally {
      await comms.stop();
    }
  };
}
