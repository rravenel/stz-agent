// #0029: a message handed over by the comms worker's last poll, after the
// run decided to exit, must not be stranded (acked, invisible, no wake).
// The fake reproduces the real worker: stop() awaits the in-flight poll, and
// that poll delivers (and acks) a message that just arrived.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Comms } from "../../shared/src/comms.ts";
import type { LogEvent } from "../../shared/src/state.ts";
import type { Message, ModelAdapter } from "./models/turn.ts";
import { adapter, World } from "./test-world.ts";

const lifecycle = (log: LogEvent[], event: string) => log.filter((e) => e.kind === "lifecycle" && (e.body as { event: string }).event === event);

/** Comms whose stop() lets one more message arrive through the "in-flight poll" first, once. */
function lastPollDelivers(w: () => World, text: string, msgId: string) {
  let fired = false;
  return (c: Comms): Comms => ({
    get self() { return c.self; },
    send: c.send.bind(c),
    onMessage: c.onMessage.bind(c),
    deleteMessage: c.deleteMessage.bind(c),
    release: c.release.bind(c),
    unackedCount: c.unackedCount.bind(c),
    finalPoll: c.finalPoll.bind(c),
    stop: async () => {
      if (!fired) {
        fired = true;
        w().say(text, msgId);
        await new Promise((r) => setImmediate(r)); // delivered (and acked) before stop returns
      }
      return c.stop();
    },
  });
}

test("stale-wake path: a message from the last poll is processed in the same run, not stranded", async () => {
  let w!: World;
  w = new World({ wrapComms: lastPollDelivers(() => w, "hello", "u1") });
  const r = await w.run("prewake");
  assert.notEqual(r.exit, "stale_wake");
  assert.equal(r.exit, "idle");
  assert.equal(r.processed, 1);
  assert.deepEqual(w.primeQueue(), [], "deleted after the checkpoint, not left invisible");
  const log = await w.log();
  assert.deepEqual(lifecycle(log, "stale_wake"), []);
  assert.equal(log.filter((e) => e.kind === "user.message").length, 1);
  assert.equal((await w.takeRequests()).length, 1, "the model call went out");
});

test("exit_idle path: a message from the last poll goes back round the loop", async () => {
  let w!: World;
  w = new World({ wrapComms: lastPollDelivers(() => w, "one more", "u2") });
  w.say("hi", "u1");
  const r = await w.run();
  assert.equal(r.exit, "idle");
  assert.equal(r.processed, 2);
  assert.deepEqual(w.primeQueue(), []);
  const log = await w.log();
  assert.equal(lifecycle(log, "exit_idle").length, 1);
  assert.equal(lifecycle(log, "checkpoint").length, 2, "checkpointed again to cover the late message");
  const ctx = (await w.state()).model_context as Message[];
  assert.deepEqual(ctx.map((m) => (m.content[0] as { text: string }).text), ["hi", "one more"]);
});

test("deadline path: a message from the last poll is absorbed before the self-wake, which stays last", async () => {
  let clock = Date.parse("2026-11-21T00:00:00Z");
  let advanced = false;
  const slow: ModelAdapter = {
    provider: adapter.provider,
    toRequest: (req) => { if (!advanced) { advanced = true; clock += 12.5 * 60_000; } return adapter.toRequest(req); },
    fromResponse: (b) => adapter.fromResponse(b),
  };
  const order: string[] = [];
  let w!: World;
  w = new World({
    now: () => new Date(clock),
    wrapComms: lastPollDelivers(() => w, "late", "u2"),
    deps: { adapter: slow, selfWake: async () => { order.push("selfWake"); } },
  });
  w.say("first", "u1");
  const r = await w.run();
  assert.equal(r.exit, "deadline");
  assert.equal(r.processed, 2);
  assert.deepEqual(w.primeQueue(), []);
  assert.deepEqual(order, ["selfWake"]);
  const log = await w.log();
  assert.equal(log.at(-1)!.kind, "lifecycle");
  assert.equal((log.at(-1)!.body as { event: string }).event, "exit_deadline");
});

test("a run with nothing late stops its worker once and exits normally", async () => {
  let stops = 0;
  const w = new World({ wrapComms: (c) => ({ ...bind(c), stop: async () => { stops++; return c.stop(); } }) });
  w.say("hi", "u1");
  const r = await w.run();
  assert.equal(r.exit, "idle");
  assert.equal(stops, 1, "stop() is idempotent: the finally doesn't stop again");
});

function bind(c: Comms): Comms {
  return {
    get self() { return c.self; },
    send: c.send.bind(c),
    onMessage: c.onMessage.bind(c),
    deleteMessage: c.deleteMessage.bind(c),
    unackedCount: c.unackedCount.bind(c),
    release: c.release.bind(c),
    finalPoll: c.finalPoll.bind(c),
    stop: c.stop.bind(c),
  };
}

// ---- released on stop (#0033) ----------------------------------------------

/** Comms whose first stop() reports an acked-but-undeleted message, without handing it over. */
function releasesOnStop(c: Comms): Comms {
  return { ...bind(c), stop: async () => { await c.stop(); return { released: 1 }; } };
}

test("stale wake: a released message gets a self-wake, after the log", async () => {
  const wakes: string[] = [];
  const w = new World({ wrapComms: releasesOnStop, deps: { selfWake: async (e) => { wakes.push(e.reason); } } });
  assert.equal((await w.run("prewake")).exit, "stale_wake");
  assert.deepEqual(wakes, ["continue"]);
});

test("exit_idle: a released message gets exactly one self-wake", async () => {
  const wakes: string[] = [];
  const w = new World({ wrapComms: releasesOnStop, deps: { selfWake: async (e) => { wakes.push(e.reason); } } });
  w.say("hi", "u1");
  assert.equal((await w.run()).exit, "idle");
  assert.deepEqual(wakes, ["continue"]);
});

test("nothing released: no self-wake", async () => {
  const wakes: string[] = [];
  const w = new World({ deps: { selfWake: async (e) => { wakes.push(e.reason); } } });
  w.say("hi", "u1");
  assert.equal((await w.run()).exit, "idle");
  assert.deepEqual(wakes, []);
});

test("a run that throws releases what it received, wakes once and keeps the original error", async () => {
  const wakes: string[] = [];
  const boom: ModelAdapter = { provider: adapter.provider, toRequest: () => { throw new Error("boom"); }, fromResponse: (b) => adapter.fromResponse(b) };
  const w = new World({ deps: { adapter: boom, selfWake: async (e) => { wakes.push(e.reason); throw new Error("wake failed"); } } });
  w.say("hi", "u1");
  await assert.rejects(w.run(), /boom/);
  assert.deepEqual(wakes, ["continue"]);
  assert.equal(w.primeQueue().length, 1, "still queued for the next run");
});

test("deadline path: a message that lands during the checkpoint is absorbed before stop(), never released", async () => {
  let clock = Date.parse("2026-11-21T00:00:00Z");
  const slow: ModelAdapter = {
    provider: adapter.provider,
    toRequest: (req) => { clock += 12.5 * 60_000; return adapter.toRequest(req); },
    fromResponse: (b) => adapter.fromResponse(b),
  };
  let w!: World;
  let said = false;
  const releasedByStop: number[] = [];
  w = new World({
    now: () => new Date(clock),
    wrapStore: (s) => ({
      get: (k) => s.get(k),
      list: (p) => s.list(p),
      put: async (k, b) => { if (!said && k.includes("state")) { said = true; w.say("late", "u2"); await new Promise((r) => setImmediate(r)); } return s.put(k, b); },
      putIfAbsent: (k, b) => s.putIfAbsent(k, b),
      delete: (k) => s.delete(k),
    }),
    wrapComms: (c) => ({ ...bind(c), stop: async () => { const r = await c.stop(); releasedByStop.push(r.released); return r; } }),
    deps: { adapter: slow, selfWake: async () => {} },
  });
  w.say("first", "u1");
  const r = await w.run();
  assert.equal(said, true);
  assert.equal(r.exit, "deadline");
  assert.equal(r.processed, 2);
  assert.equal(r.duplicates, 0);
  assert.deepEqual(releasedByStop, [0], "one stop, nothing released");
  assert.deepEqual(w.primeQueue(), []);
});

test("a failed self-wake for released messages is tried again on the way out", async () => {
  let n = 0;
  const w = new World({ wrapComms: releasesOnStop, deps: { selfWake: async () => { if (++n === 1) throw new Error("throttled"); } } });
  w.say("hi", "u1");
  await assert.rejects(w.run(), /throttled/);
  assert.equal(n, 2);
});
