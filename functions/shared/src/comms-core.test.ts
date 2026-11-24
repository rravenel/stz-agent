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
      release: async (receipt) => {
        const m = this.items(self).find((x) => x.receipt === receipt);
        if (m) m.inFlight = false;
      },
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

// ---- acceptDeadlineAtMs (Com) -------------------------------------------

function httpReq(timeout_s: number) {
  return makeEnvelope("http.request", "prime", "com", {
    request_id: `r-${timeout_s}`, method: "GET", url: "mock://slow", headers: {}, auth: "none", timeout_s, purpose: "repl",
  });
}

function deadlineCom(fq: FakeQueue, log: LogEvent[], acceptDeadlineAtMs?: number) {
  const opts = acceptDeadlineAtMs === undefined ? {} : { acceptDeadlineAtMs };
  const c = new CommsCore("com", fq.port("com"), new FakeWake(), (e) => log.push(e), opts).start();
  cores.push(c);
  return c;
}

test("deadline: a request that doesn't fit is declined: no ack, no hand-off, stays queued", async () => {
  const fq = new FakeQueue();
  const log: LogEvent[] = [];
  const got: Delivery[] = [];
  deadlineCom(fq, log, 60_000).onMessage((d) => got.push(d));
  const m = httpReq(120);
  fq.push("com", JSON.stringify(m));
  await advance(300);
  assert.equal(got.length, 0);
  assert.equal(fq.pending("prime").length, 0, "no ack");
  assert.deepEqual(fq.pending("com").map((x) => x.msg_id), [m.msg_id]);
  assert.deepEqual(log.filter((e) => e.kind === "declined"), [{ kind: "declined", msg_id: m.msg_id, reason: "deadline" }]);
});

test("deadline: a request that fits is acked and handed off", async () => {
  const fq = new FakeQueue();
  const got: Delivery[] = [];
  deadlineCom(fq, [], 60_000).onMessage((d) => got.push(d));
  fq.push("com", JSON.stringify(httpReq(30)));
  await advance(300);
  assert.equal(got.length, 1);
  assert.equal(fq.pending("prime").filter((x) => x.type === "ack").length, 1);
});

test("deadline: unset accepts anything; set never applies to other types", async () => {
  const fq = new FakeQueue();
  const got: Delivery[] = [];
  deadlineCom(fq, []).onMessage((d) => got.push(d));
  fq.push("com", JSON.stringify(httpReq(100_000)));
  await advance(300);
  assert.equal(got.length, 1);
  const fq2 = new FakeQueue();
  const got2: Delivery[] = [];
  deadlineCom(fq2, [], 1).onMessage((d) => got2.push(d));
  fq2.push("com", JSON.stringify(makeEnvelope("user.message", "doorman", "com", { text: "x" })));
  await advance(300);
  assert.equal(got2.length, 1);
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

// ---- stop() (#0033) ------------------------------------------------------

const userMsg = (text = "x") => makeEnvelope("user.message", "doorman", "prime", { text }) as Envelope;

test("stop: a message from the in-flight poll is not acked, not delivered, and visible to the next consumer", async () => {
  const fq = new FakeQueue();
  const log: LogEvent[] = [];
  const got: Delivery[] = [];
  const wake = new FakeWake();
  const doorman = core("doorman", fq, wake);
  doorman.onMessage(() => {});
  const p1 = core("prime", fq, new FakeWake(), log);
  p1.onMessage((d) => got.push(d));
  await flush();
  const stopping = p1.stop();
  const sent = doorman.send("prime", "user.message", { text: "late" });
  await flush();
  await flush();
  assert.deepEqual(await stopping, { released: 0 }, "never acked, so its sender still wakes us");
  assert.equal(got.length, 0);
  assert.equal(fq.pending("doorman").length, 0, "no ack");
  assert.equal(fq.items("prime")[0]!.inFlight, false);
  assert.deepEqual(log, [{ kind: "released", msg_id: sent.msg_id, reason: "stopping" }]);
  await advance(3600);
  assert.equal(doorman.unackedCount(), 1);
  assert.equal(wake.calls.length, 1, "the sender's monitor wakes again");
  const got2: Delivery[] = [];
  core("prime", fq, new FakeWake()).onMessage((d) => got2.push(d));
  await advance(300);
  assert.deepEqual(got2.map((d) => d.msg.msg_id), [sent.msg_id]);
});

test("stop: releases delivered-but-undeleted messages only, and is idempotent", async () => {
  const fq = new FakeQueue();
  const got: Delivery[] = [];
  const p = core("prime", fq, new FakeWake());
  p.onMessage((d) => got.push(d));
  fq.push("prime", JSON.stringify(userMsg("a")));
  fq.push("prime", JSON.stringify(userMsg("b")));
  await advance(300);
  assert.equal(got.length, 2);
  void p.deleteMessage(got[0]!.receipt); // not awaited: stop() waits for it
  const s = p.stop();
  await advance(2500);
  assert.deepEqual(await s, { released: 1 });
  assert.deepEqual(await p.stop(), { released: 1 });
  assert.deepEqual(fq.pending("prime").map((m) => m.msg_id), [got[1]!.msg.msg_id]);
  assert.equal(fq.items("prime")[0]!.inFlight, false);
});

test("stop: a message held for a missing handler is released too", async () => {
  const fq = new FakeQueue();
  const p = core("prime", fq, new FakeWake());
  fq.push("prime", JSON.stringify(userMsg()));
  await advance(300);
  const s = p.stop();
  await advance(2500);
  assert.deepEqual(await s, { released: 1 });
});

test("stop: beginning during the ack releases and counts, without delivering", async () => {
  const fq = new FakeQueue();
  const got: Delivery[] = [];
  const port = fq.port("prime");
  let letAck!: () => void;
  const gate = new Promise<void>((r) => (letAck = r));
  const p = new CommsCore("prime", { ...port, send: async (to, m) => { await gate; return port.send(to, m); } }, new FakeWake()).start();
  cores.push(p);
  p.onMessage((d) => got.push(d));
  fq.push("prime", JSON.stringify(userMsg()));
  await flush();
  await flush();
  const s = p.stop();
  letAck();
  assert.deepEqual(await s, { released: 1 });
  assert.equal(got.length, 0);
});

test("stop: acks from the last poll still clear entries", async () => {
  const fq = new FakeQueue();
  const p = core("prime", fq, new FakeWake());
  p.onMessage(() => {});
  const sent = p.send("com", "http.request", httpReq(30).body as never);
  await flush();
  const s = p.stop();
  fq.push("prime", JSON.stringify(makeEnvelope("ack", "com", "prime", { acked_msg_id: sent.msg_id })));
  await s;
  assert.equal(p.unackedCount(), 0);
});

test("stop: a failed release is logged and not counted", async () => {
  const fq = new FakeQueue();
  const log: LogEvent[] = [];
  const p = new CommsCore("prime", { ...fq.port("prime"), release: async () => { throw new Error("gone"); } }, new FakeWake(), (e) => log.push(e)).start();
  cores.push(p);
  p.onMessage(() => {});
  fq.push("prime", JSON.stringify(userMsg()));
  await advance(300);
  const s = p.stop();
  await advance(2500);
  assert.deepEqual(await s, { released: 0 });
  assert.ok(log.some((e) => e.kind === "release-failed"));
});

test("stop: a redelivered message is counted: an earlier run may have acked it", async () => {
  const fq = new FakeQueue();
  const port = fq.port("prime");
  const p = new CommsCore("prime", { ...port, receive: async (w) => (await port.receive(w)).map((m) => ({ ...m, receives: 2 })) }, new FakeWake()).start();
  cores.push(p);
  p.onMessage(() => {});
  await flush();
  const s = p.stop();
  fq.push("prime", JSON.stringify(userMsg()));
  assert.deepEqual(await s, { released: 1 });
});

test("stop: waits for a pending delete, and releases when that delete fails", async () => {
  const fq = new FakeQueue();
  const got: Delivery[] = [];
  let fail!: () => void;
  const gate = new Promise<void>((_, rej) => (fail = () => rej(new Error("delete failed"))));
  const p = new CommsCore("prime", { ...fq.port("prime"), delete: () => gate }, new FakeWake()).start();
  cores.push(p);
  p.onMessage((d) => got.push(d));
  fq.push("prime", JSON.stringify(userMsg()));
  await advance(300);
  const del = assert.rejects(p.deleteMessage(got[0]!.receipt), /delete failed/);
  let done = false;
  const s = p.stop().then((r) => ((done = true), r));
  await advance(2500);
  assert.equal(done, false, "still waiting for the delete");
  fail();
  await del;
  assert.deepEqual(await s, { released: 1 });
});

test("stop: waits for a finalPoll in flight", async () => {
  const fq = new FakeQueue();
  const p = new CommsCore("prime", fq.port("prime"), new FakeWake());
  p.onMessage(() => {});
  void p.finalPoll(1000);
  await flush();
  const s = p.stop();
  fq.push("prime", JSON.stringify(userMsg()));
  assert.deepEqual(await s, { released: 0 });
  assert.equal(fq.items("prime")[0]!.inFlight, false);
});
