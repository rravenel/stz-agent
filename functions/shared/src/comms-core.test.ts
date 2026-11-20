import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { CommsCore, DeliveryMonitor, type LogEvent, type QueuePort, type WakeKind, type WakePort } from "./comms-core.ts";
import { classifyInvoke } from "./aws-ports.ts";
import { makeEnvelope, type Endpoint, type Envelope } from "./envelope.ts";
import type { Delivery } from "./comms.ts";

// ---- fakes -----------------------------------------------------------------

interface Item {
  body: string;
  receipt: string;
  inFlight: boolean;
}

/** Three in-memory queues; a message stays until deleted (SQS-like). */
class FakeQueue {
  readonly q = new Map<Endpoint, Item[]>();
  private n = 0;
  private waiters = new Map<Endpoint, () => void>();

  items(e: Endpoint): Item[] {
    let a = this.q.get(e);
    if (!a) this.q.set(e, (a = []));
    return a;
  }
  /** Messages (parsed) in e's queue, delivered or not. */
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
        const a = this.items(self);
        const i = a.findIndex((x) => x.receipt === receipt);
        if (i >= 0) a.splice(i, 1);
      },
    };
  }
}

class FakeWake implements WakePort {
  readonly calls: { to: Endpoint; at: number; kind: WakeKind }[] = [];
  private readonly script: WakeKind[];
  onWake: ((to: Endpoint, kind: WakeKind) => void) | null = null;
  constructor(script: WakeKind[] = ["started"]) {
    this.script = script;
  }
  async wake(to: Endpoint) {
    const kind = this.script[Math.min(this.calls.length, this.script.length - 1)]!;
    this.calls.push({ to, at: Date.now(), kind });
    this.onWake?.(to, kind);
    return { kind };
  }
}

const flush = () => new Promise<void>((r) => setImmediate(r));

/** Advance fake time in small steps, letting promises settle between steps. */
async function advance(ms: number, step = 100): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    mock.timers.tick(step);
    for (let i = 0; i < 5; i++) await flush();
  }
}

const resp = { request_id: "req-1", ok: true, status: 200, elapsed_ms: 1 };

let cores: CommsCore[] = [];
function core(self: Endpoint, fq: FakeQueue, wake: WakePort, log: LogEvent[] = []) {
  const c = new CommsCore(self, fq.port(self), wake, (e) => log.push(e)).start();
  cores.push(c);
  return c;
}

beforeEach(() => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 0 });
});
afterEach(async () => {
  const stopping = cores.map((c) => c.stop());
  cores = [];
  mock.timers.tick(10_000);
  await flush();
  await Promise.all(stopping);
  mock.timers.reset();
});

// ---- DeliveryMonitor -----------------------------------------------------

test("monitor: no wake at or before ACK_TIMEOUT, a wake just after", () => {
  const m = new DeliveryMonitor();
  m.track("prime", "a", 0);
  assert.deepEqual(m.due(3000), []);
  assert.deepEqual(m.due(3001), ["prime"]);
});

test("monitor: second wake only after WAKE_ACK_TIMEOUT for that recipient", () => {
  const m = new DeliveryMonitor();
  m.track("prime", "a", 0);
  m.track("com", "b", 0);
  m.markWoken("prime", 3500);
  m.markWoken("com", 3500);
  assert.deepEqual(m.due(8500), []);
  assert.deepEqual(m.due(8501), ["com"]);
  assert.deepEqual(m.due(18501), ["prime", "com"]);
});

test("monitor: one wake covers N pending messages; ack clears and resets", () => {
  const m = new DeliveryMonitor();
  for (const id of ["a", "b", "c"]) m.track("com", id, 0);
  assert.deepEqual(m.due(4000), ["com"]);
  m.markWoken("com", 4000);
  assert.equal(m.count(), 3);
  for (const id of ["a", "b", "c"]) assert.ok(m.ack(id));
  assert.equal(m.count(), 0);
  assert.deepEqual(m.due(100_000), []);
  assert.equal(m.ack("a"), false);
  m.track("com", "d", 100_000); // lastWakeAt was reset: ACK_TIMEOUT again
  assert.deepEqual(m.due(103_001), ["com"]);
});

test("core: never re-sends; one wake for many messages; ack stops wakes", async () => {
  const fq = new FakeQueue();
  const wake = new FakeWake(["started"]);
  const com = core("com", fq, wake);
  com.send("prime", "http.response", resp);
  com.send("prime", "http.response", { ...resp, request_id: "req-2" });
  await advance(3600);
  assert.equal(wake.calls.length, 1);
  assert.equal(fq.pending("prime").length, 2);
  await advance(16000); // 3.5 s + 15.5 s (WAKE_ACK_TIMEOUT(prime), on a 500 ms tick)
  assert.equal(wake.calls.length, 2);
  assert.equal(fq.pending("prime").length, 2, "only the wake repeats");
  core("prime", fq, new FakeWake()).onMessage(() => {});
  await advance(600);
  assert.equal(com.unackedCount(), 0);
  const n = wake.calls.length;
  await advance(20_000);
  assert.equal(wake.calls.length, n);
});

// ---- protocol §9 walkthroughs ---------------------------------------------

test("walkthrough A: Prime asleep, wake → started, Prime acks, Com's set empties", async () => {
  const fq = new FakeQueue();
  const log: LogEvent[] = [];
  const wake = new FakeWake(["started"]);
  const com = core("com", fq, wake, log);
  wake.onWake = (to) => {
    if (to === "prime") core("prime", fq, new FakeWake()).onMessage(() => {});
  };
  com.send("prime", "http.response", resp);
  await advance(2900);
  assert.equal(wake.calls.length, 0, "no wake before 3 s");
  await advance(1000);
  assert.equal(wake.calls.length, 1);
  assert.deepEqual(log.filter((e) => e.kind === "wake").map((e) => e.kind === "wake" && e.result.kind), ["started"]);
  await advance(500);
  assert.equal(com.unackedCount(), 0);
  await advance(30_000);
  assert.equal(wake.calls.length, 1, "no more wakes");
});

test("walkthrough B: first wake 429 (running), next only after 15 s, then started and ack", async () => {
  const fq = new FakeQueue();
  const wake = new FakeWake(["running", "started"]);
  const com = core("com", fq, wake);
  wake.onWake = (to, kind) => {
    if (to === "prime" && kind === "started") core("prime", fq, new FakeWake()).onMessage(() => {});
  };
  com.send("prime", "http.response", resp);
  await advance(3600);
  assert.equal(wake.calls.length, 1);
  const first = wake.calls[0]!.at;
  await advance(14_800);
  assert.equal(wake.calls.length, 1, "waits WAKE_ACK_TIMEOUT(prime)");
  await advance(1000);
  assert.equal(wake.calls.length, 2);
  assert.ok(wake.calls[1]!.at - first > 15_000);
  await advance(500);
  assert.equal(com.unackedCount(), 0);
});

test("walkthrough C: busy recipient still acks before its handler runs; no wake", async () => {
  const fq = new FakeQueue();
  const wake = new FakeWake();
  const prime = core("prime", fq, new FakeWake());
  const com = core("com", fq, wake);
  const order: string[] = [];
  const push = fq.push.bind(fq);
  fq.push = (e, body) => {
    order.push(`${e}:${(JSON.parse(body) as Envelope).type}`);
    push(e, body);
  };
  prime.onMessage(() => {
    order.push("handler");
    // Model a 20 s eval: the handler never returns control to its queue work.
    void new Promise(() => {});
  });
  com.send("prime", "http.response", resp);
  await advance(500);
  assert.deepEqual(order, ["prime:http.response", "com:ack", "handler"]);
  assert.equal(com.unackedCount(), 0);
  await advance(20_000);
  assert.equal(wake.calls.length, 0);
});

test("walkthrough D: wake keeps failing; repeats every WAKE_ACK_TIMEOUT, logged, message stays", async () => {
  const fq = new FakeQueue();
  const log: LogEvent[] = [];
  const wake = new FakeWake(["failed"]);
  const prime = core("prime", fq, wake, log);
  prime.send("com", "http.request", {
    request_id: "req-1",
    method: "GET",
    url: "https://x",
    headers: {},
    auth: "none",
    timeout_s: 10,
    purpose: "repl",
  });
  await advance(3500 + 5500 * 3 + 100); // first wake on the 3.5 s tick, then every 5.5 s
  assert.equal(wake.calls.length, 4);
  for (let i = 1; i < wake.calls.length; i++) {
    const gap = wake.calls[i]!.at - wake.calls[i - 1]!.at;
    assert.ok(gap > 5000 && gap <= 5600, `gap ${gap}`);
  }
  assert.equal(log.filter((e) => e.kind === "wake" && e.result.kind === "failed").length, 4);
  assert.equal(fq.pending("com").length, 1);
  assert.equal(prime.unackedCount(), 1);
});

// ---- receiver ------------------------------------------------------------

test("receiver acks before hand-off, deletes acks, deletes and logs poison", async () => {
  const fq = new FakeQueue();
  const log: LogEvent[] = [];
  const got: Delivery[] = [];
  const prime = core("prime", fq, new FakeWake(), log);
  fq.push("prime", "{not json");
  fq.push("prime", JSON.stringify(makeEnvelope("ack", "com", "prime", { acked_msg_id: "nobody" })));
  const msg = makeEnvelope("user.message", "doorman", "prime", { text: "hi" });
  fq.push("prime", JSON.stringify(msg));
  prime.onMessage((d) => {
    assert.ok(fq.pending("doorman").some((m) => m.type === "ack" && m.body.acked_msg_id === msg.msg_id));
    got.push(d);
  });
  await advance(300);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.msg.msg_id, msg.msg_id);
  assert.equal(log.filter((e) => e.kind === "poison").length, 1);
  assert.deepEqual(fq.pending("prime").map((m) => m.msg_id), [msg.msg_id], "only the unhandled message is left");
  await prime.deleteMessage(got[0]!.receipt);
  assert.equal(fq.pending("prime").length, 0);
});

test("finalPoll: true when nothing arrives, false when a message does", async () => {
  const fq = new FakeQueue();
  const prime = new CommsCore("prime", fq.port("prime"), new FakeWake());
  prime.onMessage(() => {});
  const empty = prime.finalPoll(1000);
  await advance(1100);
  assert.equal(await empty, true);
  fq.push("prime", JSON.stringify(makeEnvelope("user.message", "doorman", "prime", { text: "x" })));
  assert.equal(await prime.finalPoll(1000), false);
});

test("a failed send is logged and retried on the next tick", async () => {
  const fq = new FakeQueue();
  const log: LogEvent[] = [];
  const port = fq.port("com");
  let fail = true;
  const flaky: QueuePort = {
    ...port,
    send: async (to, m) => {
      if (fail) {
        fail = false;
        throw new Error("boom");
      }
      return port.send(to, m);
    },
  };
  const com = new CommsCore("com", flaky, new FakeWake(), (e) => log.push(e)).start();
  cores.push(com);
  com.send("prime", "http.response", resp);
  await flush();
  assert.equal(log[0]?.kind, "send-failed");
  await advance(600);
  assert.equal(fq.pending("prime").length, 1);
});

// ---- classifyInvoke ------------------------------------------------------

test("classifyInvoke: abort → started, 429 → running, FunctionError → failed, other → error", () => {
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  assert.equal(classifyInvoke({ ok: false, error: abort }).kind, "started");
  const tooMany = Object.assign(new Error("x"), {
    name: "TooManyRequestsException",
    Reason: "ReservedFunctionConcurrentInvocationLimitExceeded",
    $metadata: { httpStatusCode: 429 },
  });
  assert.deepEqual(classifyInvoke({ ok: false, error: tooMany }), {
    kind: "running",
    detail: "ReservedFunctionConcurrentInvocationLimitExceeded",
  });
  assert.equal(classifyInvoke({ ok: false, error: { $metadata: { httpStatusCode: 429 } } }).kind, "running");
  assert.equal(classifyInvoke({ ok: true, StatusCode: 200, FunctionError: "Unhandled" }).kind, "failed");
  assert.equal(classifyInvoke({ ok: true, StatusCode: 200 }).kind, "started");
  assert.equal(classifyInvoke({ ok: false, error: Object.assign(new Error("x"), { name: "ResourceNotFoundException" }) }).kind, "error");
});
