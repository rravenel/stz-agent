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
    finalPoll: c.finalPoll.bind(c),
    stop: c.stop.bind(c),
  };
}
