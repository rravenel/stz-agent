import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { makeAck, makeEnvelope } from "../../shared/src/envelope.ts";
import type { InvokeOutcome } from "../../shared/src/aws-ports.ts";
import { MAX_TEXT_BYTES, route, type Deps } from "./doorman.ts";
import { advance, ev, FakeQueue, FakeWake, flush, TOKEN } from "./testing.ts";

let fq: FakeQueue;
let wake: FakeWake;
let logs: object[];

function deps(extra: Partial<Deps> = {}): Deps {
  return { token: TOKEN, comms: () => ({ queue: fq.port("doorman"), wake }), log: (o) => logs.push(o), ...extra };
}

/** Fake Prime: after delayMs, ack every user.message in prime's queue. */
function primeAcksAfter(delayMs: number) {
  setTimeout(() => {
    for (const m of fq.pending("prime")) fq.push("doorman", JSON.stringify(makeAck(m)));
  }, delayMs);
}

beforeEach(() => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 0 });
  fq = new FakeQueue();
  wake = new FakeWake();
  logs = [];
});
afterEach(() => mock.timers.reset());

async function run<T>(p: Promise<T>, ms: number): Promise<T> {
  await advance(ms);
  return p;
}

test("POST /messages: 202 on ack, client msg_id kept", async () => {
  primeAcksAfter(500);
  const r = await run(route(deps(), ev("POST", "/messages", { body: { msg_id: "m-1", text: "/clear" } })), 2500);
  assert.equal(r.statusCode, 202);
  assert.deepEqual(JSON.parse(r.body), { msg_id: "m-1" });
  const sent = fq.pending("prime");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.type, "user.message");
  assert.equal(sent[0]!.msg_id, "m-1");
  assert.deepEqual(sent[0]!.body, { text: "/clear" });
  assert.equal(wake.calls.length, 0);
});

test("POST /messages: 503 after 20 s with two wakes and one send", async () => {
  const p = route(deps(), ev("POST", "/messages", { body: { msg_id: "m-2", text: "hi" } }));
  let done = false;
  void p.then(() => (done = true));
  await advance(19_800);
  assert.equal(done, false);
  const r = await run(p, 2000);
  assert.equal(r.statusCode, 503);
  assert.equal(JSON.parse(r.body).msg_id, "m-2");
  assert.equal(wake.calls.length, 2);
  assert.ok(wake.calls.every((c) => c.to === "prime"));
  assert.equal(fq.pending("prime").length, 1);
  assert.equal(logs.filter((l) => (l as { kind: string }).kind === "wake").length, 2);
});

test("POST /messages: a retry re-enqueues with the same msg_id", async () => {
  const body = { msg_id: "m-3", text: "again" };
  const r1 = await run(route(deps(), ev("POST", "/messages", { body })), 22_000);
  assert.equal(r1.statusCode, 503);
  primeAcksAfter(300);
  const r2 = await run(route(deps(), ev("POST", "/messages", { body })), 2500);
  assert.equal(r2.statusCode, 202);
  assert.deepEqual(fq.pending("prime").map((m) => m.msg_id), ["m-3", "m-3"]);
});

test("POST /messages: a stale ack is deleted and doesn't count", async () => {
  const old = makeEnvelope("user.message", "doorman", "prime", { text: "old" }, { msg_id: "stale" });
  fq.push("doorman", JSON.stringify(makeAck(old)));
  const p = route(deps({ ackWaitMs: 2000 }), ev("POST", "/messages", { body: { msg_id: "m-4", text: "x" } }));
  const r = await run(p, 4000);
  assert.equal(r.statusCode, 503);
  assert.equal(fq.items("doorman").length, 0);
  assert.equal(fq.deleted.length, 1);
});

test("POST /messages: validation", async () => {
  const d = deps();
  const bad = [
    { msg_id: "", text: "x" },
    { msg_id: "a/b", text: "x" },
    { msg_id: "x".repeat(129), text: "x" },
    { msg_id: "ok", text: 5 },
    { msg_id: "ok", text: "x".repeat(MAX_TEXT_BYTES + 1) },
    null,
  ];
  for (const body of bad) assert.equal((await route(d, ev("POST", "/messages", { body: JSON.stringify(body) }))).statusCode, 400);
  assert.equal((await route(d, ev("POST", "/messages", { body: "{nope" }))).statusCode, 400);
  assert.equal((await route(d, ev("GET", "/nowhere"))).statusCode, 404);
  assert.equal(fq.pending("prime").length, 0);
});

test("auth: 401 on every route without the right token; token never logged", async () => {
  const d = deps({ prime: { invoke: async () => ({ ok: true, StatusCode: 200 }) }, store: { list: async () => ({ keys: [], truncated: false }), getText: async () => "" } });
  for (const [m, p] of [["POST", "/messages"], ["POST", "/wake"], ["GET", "/events"]] as const) {
    for (const token of [null, "wrong", `${TOKEN}x`]) {
      const r = await route(d, ev(m, p, { token, body: { msg_id: "a", text: "b" } }));
      assert.equal(r.statusCode, 401, `${m} ${p} ${token}`);
    }
  }
  assert.equal((await route(d, ev("POST", "/wake"))).statusCode, 202);
  const ok = route(d, ev("GET", "/events"));
  assert.equal((await ok).statusCode, 200);
  await flush();
  assert.ok(!JSON.stringify(logs).includes(TOKEN));
  assert.equal(fq.pending("prime").length, 0);
});

test("POST /wake: always 202, payload {reason: prewake}, no message sent", async () => {
  const cases: [InvokeOutcome, string][] = [
    [{ ok: false, error: { name: "TooManyRequestsException" } }, "running"],
    [{ ok: false, error: { name: "AbortError" } }, "started"],
    [{ ok: true, StatusCode: 200, FunctionError: "Unhandled" }, "failed"],
    [{ ok: false, error: { name: "ServiceException" } }, "error"],
  ];
  for (const [outcome, kind] of cases) {
    const payloads: object[] = [];
    const d = deps({ prime: { invoke: async (p) => (payloads.push(p), outcome) } });
    const r = await route(d, ev("POST", "/wake"));
    assert.equal(r.statusCode, 202);
    assert.deepEqual(JSON.parse(r.body), { wake: kind });
    assert.deepEqual(payloads, [{ reason: "prewake" }]);
  }
  const thrown = await route(deps({ prime: { invoke: async () => { throw new Error("boom"); } } }), ev("POST", "/wake"));
  assert.deepEqual(JSON.parse(thrown.body), { wake: "error" });
  assert.equal(fq.pending("prime").length, 0);
});
