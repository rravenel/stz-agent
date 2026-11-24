// The comms worker (protocol §6): CommsCore in a worker_threads worker, so
// acks keep flowing while Prime's main thread is blocked. This one file is
// both sides: WorkerComms on the main thread spawns this file as the worker,
// which runs CommsCore when it sees workerData.stzComms. An esbuild bundle
// re-executes itself the same way, so build.mjs needs no change.

import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { Comms, Delivery, StopResult } from "./comms.ts";
import { fromEnv } from "./aws-ports.ts";
import { CommsCore, type CommsOptions, type LogEvent, type QueuePort, type WakePort } from "./comms-core.ts";
import { makeEnvelope, type BodyByType, type Endpoint, type Envelope, type MakeOptions, type MessageType } from "./envelope.ts";

export type WorkerMode = "aws" | "memory";

interface WorkerInit {
  stzComms: true;
  self: Endpoint;
  mode: WorkerMode;
  opts: Partial<CommsOptions>;
}

type ToWorker =
  | { op: "send"; msg: Envelope }
  | { op: "delete"; id: number; receipt: string }
  | { op: "release"; id: number; receipt: string }
  | { op: "finalPoll"; id: number; graceMs: number }
  | { op: "stop"; id: number };

type FromWorker =
  | { op: "delivery"; delivery: Delivery }
  | { op: "count"; n: number; sendsSeen: number }
  | { op: "done"; id: number; value?: unknown; error?: string }
  | { op: "log"; event: LogEvent };

/**
 * Main-side unacked count, reconciled with the worker's pushes. A push says
 * "n unacked after I processed sendsSeen sends"; sends main posted since then
 * are still in flight to the worker, so they count too. Never overwrite with
 * a stale push (that read 0 while a just-posted send was unacked).
 */
export class UnackedTracker {
  private posted = 0;
  private n = 0;
  private seen = 0;
  /** main posted a non-ack send */
  posted1(): void {
    this.posted++;
  }
  /** worker pushed { n, sendsSeen } */
  push(n: number, sendsSeen: number): void {
    if (sendsSeen < this.seen) return; // out-of-order guard (postMessage is FIFO, but be safe)
    this.n = n;
    this.seen = sendsSeen;
  }
  count(): number {
    return this.n + (this.posted - this.seen);
  }
}

export class WorkerComms implements Comms {
  readonly self: Endpoint;
  private readonly worker: Worker;
  private handler: ((d: Delivery) => void) | null = null;
  private readonly held: Delivery[] = [];
  private readonly unacked = new UnackedTracker();
  private nextId = 1;
  private stopping = false;
  private dead: Error | null = null;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(self: Endpoint, opts: { mode?: WorkerMode; comms?: Partial<CommsOptions>; log?: (e: LogEvent) => void } = {}) {
    this.self = self;
    const init: WorkerInit = { stzComms: true, self, mode: opts.mode ?? "aws", opts: opts.comms ?? {} };
    const log = opts.log ?? ((e: LogEvent) => console.log(JSON.stringify({ comms: e })));
    this.worker = new Worker(fileURLToPath(import.meta.url), { workerData: init });
    this.worker.on("message", (m: FromWorker) => {
      switch (m.op) {
        case "delivery":
          // Raced stop(): the worker still tracks it, so its stop() releases and counts it.
          if (this.stopping) break;
          if (this.handler) this.handler(m.delivery);
          else this.held.push(m.delivery);
          break;
        case "count":
          this.unacked.push(m.n, m.sendsSeen);
          break;
        case "log":
          log(m.event);
          break;
        case "done": {
          const p = this.pending.get(m.id);
          this.pending.delete(m.id);
          if (m.error !== undefined) p?.reject(new Error(m.error));
          else p?.resolve(m.value);
          break;
        }
      }
    });
    this.worker.on("error", (e) => this.rejectAll(e));
    this.worker.on("exit", (code) => this.rejectAll(new Error(`comms worker exited (code ${code})`)));
  }

  send<T extends MessageType>(to: Endpoint, type: T, body: BodyByType[T], opts?: MakeOptions): Envelope {
    const msg = makeEnvelope(type, this.self, to, body, opts) as Envelope;
    if (type !== "ack") this.unacked.posted1(); // in flight until a push covers it
    this.post({ op: "send", msg });
    return msg;
  }

  onMessage(handler: (d: Delivery) => void): void {
    this.handler = handler;
    for (const d of this.held.splice(0)) handler(d);
  }

  async deleteMessage(receipt: string): Promise<void> {
    await this.call((id) => ({ op: "delete", id, receipt }));
  }

  unackedCount(): number {
    return this.unacked.count();
  }

  async finalPoll(graceMs: number): Promise<boolean> {
    return (await this.call((id) => ({ op: "finalPoll", id, graceMs }))) as boolean;
  }

  async release(receipt: string): Promise<void> {
    await this.call((id) => ({ op: "release", id, receipt }));
  }

  async stop(): Promise<StopResult> {
    this.stopping = true;
    this.held.length = 0;
    const r = (await this.call((id) => ({ op: "stop", id }))) as StopResult;
    await this.worker.terminate();
    return r;
  }

  private rejectAll(e: Error): void {
    this.dead ??= e;
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  private post(m: ToWorker): void {
    this.worker.postMessage(m);
  }

  private call(make: (id: number) => ToWorker): Promise<unknown> {
    if (this.dead) return Promise.reject(this.dead); // nobody is left to answer
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post(make(id));
    });
  }
}

/** In-worker fake ports for mode "memory": one queue, every message loops back to self. */
export function memoryPorts(): { queue: QueuePort; wake: WakePort } {
  const q: { body: string; receipt: string }[] = [];
  const inFlight = new Map<string, { body: string; receipt: string }>();
  let n = 0;
  let notify: (() => void) | null = null;
  const queue: QueuePort = {
    async receive(waitSeconds) {
      if (q.length === 0) {
        await new Promise<void>((r) => {
          const t = setTimeout(r, waitSeconds * 1000);
          notify = () => {
            clearTimeout(t);
            r();
          };
        });
        notify = null;
      }
      const out = q.splice(0);
      for (const m of out) inFlight.set(m.receipt, m);
      return out;
    },
    async send(_to, msg) {
      q.push({ body: JSON.stringify(msg), receipt: `m${++n}` });
      notify?.();
    },
    async delete(receipt) {
      inFlight.delete(receipt);
    },
    async release(receipt) {
      const m = inFlight.get(receipt);
      if (!m) return;
      inFlight.delete(receipt);
      q.push(m);
      notify?.();
    },
  };
  return { queue, wake: { wake: async () => ({ kind: "started" }) } };
}

function runWorker(init: WorkerInit): void {
  const port = parentPort!;
  const { queue, wake } = init.mode === "memory" ? memoryPorts() : fromEnv(init.self);
  const out = (m: FromWorker) => port.postMessage(m);
  const core = new CommsCore(init.self, queue, wake, (event) => out({ op: "log", event }), init.opts);
  let sendsSeen = 0;
  core.onCountChange = (n) => out({ op: "count", n, sendsSeen });
  core.onMessage((delivery) => out({ op: "delivery", delivery }));
  core.start();
  port.on("message", async (m: ToWorker) => {
    try {
      switch (m.op) {
        case "send":
          if (m.msg.type !== "ack") sendsSeen++; // before sendEnvelope, so its push covers this send
          core.sendEnvelope(m.msg);
          break;
        case "delete":
          await core.deleteMessage(m.receipt);
          out({ op: "done", id: m.id });
          break;
        case "release":
          await core.release(m.receipt);
          out({ op: "done", id: m.id });
          break;
        case "finalPoll":
          out({ op: "done", id: m.id, value: await core.finalPoll(m.graceMs) });
          break;
        case "stop":
          out({ op: "done", id: m.id, value: await core.stop() });
          break;
      }
    } catch (e) {
      if ("id" in m) out({ op: "done", id: m.id, error: String(e) });
    }
  });
}

if (!isMainThread && (workerData as Partial<WorkerInit> | null)?.stzComms) runWorker(workerData as WorkerInit);
