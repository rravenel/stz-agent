// The comms worker (protocol §6): CommsCore in a worker_threads worker, so
// acks keep flowing while Prime's main thread is blocked. This one file is
// both sides: WorkerComms on the main thread spawns this file as the worker,
// which runs CommsCore when it sees workerData.stzComms. An esbuild bundle
// re-executes itself the same way, so build.mjs needs no change.

import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { Comms, Delivery } from "./comms.ts";
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
  | { op: "finalPoll"; id: number; graceMs: number }
  | { op: "stop"; id: number };

type FromWorker =
  | { op: "delivery"; delivery: Delivery }
  | { op: "count"; n: number }
  | { op: "done"; id: number; value?: unknown; error?: string }
  | { op: "log"; event: LogEvent };

export class WorkerComms implements Comms {
  readonly self: Endpoint;
  private readonly worker: Worker;
  private handler: ((d: Delivery) => void) | null = null;
  private readonly held: Delivery[] = [];
  private count = 0;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(self: Endpoint, opts: { mode?: WorkerMode; comms?: Partial<CommsOptions>; log?: (e: LogEvent) => void } = {}) {
    this.self = self;
    const init: WorkerInit = { stzComms: true, self, mode: opts.mode ?? "aws", opts: opts.comms ?? {} };
    const log = opts.log ?? ((e: LogEvent) => console.log(JSON.stringify({ comms: e })));
    this.worker = new Worker(fileURLToPath(import.meta.url), { workerData: init });
    this.worker.on("message", (m: FromWorker) => {
      switch (m.op) {
        case "delivery":
          if (this.handler) this.handler(m.delivery);
          else this.held.push(m.delivery);
          break;
        case "count":
          this.count = m.n;
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
    this.worker.on("error", (e) => {
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    });
  }

  send<T extends MessageType>(to: Endpoint, type: T, body: BodyByType[T], opts?: MakeOptions): Envelope {
    const msg = makeEnvelope(type, this.self, to, body, opts) as Envelope;
    if (type !== "ack") this.count++; // the worker's push will confirm it
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
    return this.count;
  }

  async finalPoll(graceMs: number): Promise<boolean> {
    return (await this.call((id) => ({ op: "finalPoll", id, graceMs }))) as boolean;
  }

  async stop(): Promise<void> {
    await this.call((id) => ({ op: "stop", id }));
    await this.worker.terminate();
  }

  private post(m: ToWorker): void {
    this.worker.postMessage(m);
  }

  private call(make: (id: number) => ToWorker): Promise<unknown> {
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
      return q.splice(0);
    },
    async send(_to, msg) {
      q.push({ body: JSON.stringify(msg), receipt: `m${++n}` });
      notify?.();
    },
    async delete() {},
  };
  return { queue, wake: { wake: async () => ({ kind: "started" }) } };
}

function runWorker(init: WorkerInit): void {
  const port = parentPort!;
  if (init.mode !== "memory") {
    // TODO(#0005): SqsQueuePort / LambdaWakePort once the AWS SDK is installed.
    throw new Error("comms worker: aws mode needs the AWS SDK ports (not yet installed)");
  }
  const { queue, wake } = memoryPorts();
  const out = (m: FromWorker) => port.postMessage(m);
  const core = new CommsCore(init.self, queue, wake, (event) => out({ op: "log", event }), init.opts);
  core.onCountChange = (n) => out({ op: "count", n });
  core.onMessage((delivery) => out({ op: "delivery", delivery }));
  core.start();
  port.on("message", async (m: ToWorker) => {
    try {
      switch (m.op) {
        case "send":
          core.sendEnvelope(m.msg);
          break;
        case "delete":
          await core.deleteMessage(m.receipt);
          out({ op: "done", id: m.id });
          break;
        case "finalPoll":
          out({ op: "done", id: m.id, value: await core.finalPoll(m.graceMs) });
          break;
        case "stop":
          await core.stop();
          out({ op: "done", id: m.id });
          break;
      }
    } catch (e) {
      if ("id" in m) out({ op: "done", id: m.id, error: String(e) });
    }
  });
}

if (!isMainThread && (workerData as Partial<WorkerInit> | null)?.stzComms) runWorker(workerData as WorkerInit);
