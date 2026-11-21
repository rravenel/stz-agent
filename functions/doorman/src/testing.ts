// Test fakes for Doorman (in the style of shared/src/comms-core.test.ts). Not bundled.

import { mock } from "node:test";
import type { QueuePort, WakeKind, WakePort } from "../../shared/src/comms-core.ts";
import type { Endpoint, Envelope } from "../../shared/src/envelope.ts";
import type { HttpEvent } from "./http.ts";

interface Item {
  body: string;
  receipt: string;
  inFlight: boolean;
}

/** Three in-memory queues; a message stays until deleted (SQS-like). */
export class FakeQueue {
  readonly q = new Map<Endpoint, Item[]>();
  readonly deleted: string[] = [];
  private n = 0;
  private waiters = new Map<Endpoint, () => void>();

  items(e: Endpoint): Item[] {
    let a = this.q.get(e);
    if (!a) this.q.set(e, (a = []));
    return a;
  }
  pending(e: Endpoint): Envelope[] {
    return this.items(e).map((i) => JSON.parse(i.body) as Envelope);
  }
  push(e: Endpoint, body: string): void {
    this.items(e).push({ body, receipt: `r${++this.n}`, inFlight: false });
    this.waiters.get(e)?.();
  }
  port(self: Endpoint): QueuePort {
    return {
      receive: async (waitSeconds) => {
        const visible = () => this.items(self).filter((i) => !i.inFlight);
        if (visible().length === 0) {
          await new Promise<void>((r) => {
            const t = setTimeout(done, waitSeconds * 1000);
            function done() {
              clearTimeout(t);
              r();
            }
            this.waiters.set(self, done);
          });
          this.waiters.delete(self);
        }
        const out = visible();
        for (const i of out) i.inFlight = true;
        return out.map(({ body, receipt }) => ({ body, receipt }));
      },
      send: async (to, msg) => this.push(to, JSON.stringify(msg)),
      delete: async (receipt) => {
        this.deleted.push(receipt);
        const a = this.items(self);
        const i = a.findIndex((x) => x.receipt === receipt);
        if (i >= 0) a.splice(i, 1);
      },
    };
  }
}

export class FakeWake implements WakePort {
  readonly calls: { to: Endpoint; at: number }[] = [];
  async wake(to: Endpoint) {
    this.calls.push({ to, at: Date.now() });
    return { kind: "started" as WakeKind };
  }
}

export const flush = () => new Promise<void>((r) => setImmediate(r));

/** Advance fake time in small steps, letting promises settle between steps. */
export async function advance(ms: number, step = 100): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    mock.timers.tick(step);
    for (let i = 0; i < 5; i++) await flush();
  }
}

export const TOKEN = "s3cr3t-token-value";

export function ev(method: string, path: string, o: { body?: unknown; token?: string | null; query?: Record<string, string> } = {}): HttpEvent {
  const headers: Record<string, string> = {};
  const token = o.token === undefined ? TOKEN : o.token;
  if (token !== null) headers["Authorization"] = `Bearer ${token}`;
  const e: HttpEvent = { rawPath: path, headers, requestContext: { http: { method } } };
  if (o.query) e.queryStringParameters = o.query;
  if (o.body !== undefined) e.body = typeof o.body === "string" ? o.body : JSON.stringify(o.body);
  return e;
}
