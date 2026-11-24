// Prime exit checklist, stale wake and 12-minute continuation (#0016, spec §5.1, §5.5; protocol §4.2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Comms } from "../../shared/src/comms.ts";
import type { LogEvent } from "../../shared/src/state.ts";
import type { ModelAdapter, Message } from "./models/turn.ts";
import { MemoryStore, type ObjectStore } from "./store.ts";
import { adapter, anthropic, kinds, toolUse, World } from "./test-world.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lifecycle = (log: LogEvent[], event: string) => log.filter((e) => e.kind === "lifecycle" && (e.body as { event: string }).event === event);

/** Records store writes, SQS deletes and the self-wake, in order. */
function recorder(ops: string[]) {
  const wrapStore = (s: MemoryStore): ObjectStore => ({
    get: (k) => s.get(k),
    list: (p) => s.list(p),
    put: async (k, b) => { ops.push(`put ${k}`); return s.put(k, b); },
    putIfAbsent: async (k, b) => { ops.push(`put ${k}`); return s.putIfAbsent(k, b); },
    delete: async (k) => { ops.push(`delete ${k}`); return s.delete(k); },
  });
  const wrapComms = (c: Comms, onFinalPoll?: () => void): Comms => ({
    get self() { return c.self; },
    send: c.send.bind(c),
    onMessage: c.onMessage.bind(c),
    deleteMessage: async (r) => { ops.push(`sqs-delete ${r}`); return c.deleteMessage(r); },
    release: c.release.bind(c),
    unackedCount: c.unackedCount.bind(c),
    finalPoll: async (ms) => { onFinalPoll?.(); return c.finalPoll(ms); },
    stop: c.stop.bind(c),
  });
  return { wrapStore, wrapComms };
}

test("stale wake: a prewake with no message logs stale_wake and returns without restoring", async () => {
  const ops: string[] = [];
  const { wrapStore } = recorder(ops);
  const w = new World({ wrapStore });
  w.say("hi", "u1");
  await w.run();
  // Something left in /tmp/workspace by the earlier run: a restore would wipe it.
  mkdirSync(w.workspaceDir, { recursive: true });
  writeFileSync(join(w.workspaceDir, "left-over.txt"), "x");
  ops.length = 0;

  const r = await w.run("prewake");
  assert.equal(r.exit, "stale_wake");
  assert.deepEqual(ops.filter((o) => !o.startsWith("put log/")), [], "no checkpoint, no workspace sync");
  assert.equal(ops.filter((o) => o.startsWith("put log/")).length, 1);
  assert.ok(existsSync(join(w.workspaceDir, "left-over.txt")), "not restored");
  assert.equal(lifecycle(await w.log(), "stale_wake").length, 1);

  // The next real run takes the seq after it, and that's not a crash.
  w.say("again", "u2");
  const r2 = await w.run();
  assert.equal(r2.exit, "idle");
  const log = await w.log();
  assert.deepEqual(lifecycle(log, "seq_conflict"), []);
  assert.deepEqual(log.map((e) => e.seq), log.map((_, i) => i), "contiguous");
});

test("a continuation with no message is not a stale wake: it restores and exits idle", async () => {
  const w = new World();
  const r = await w.run("continue");
  assert.equal(r.exit, "idle");
  assert.deepEqual(kinds(await w.log()), ["lifecycle:start", "lifecycle:checkpoint", "lifecycle:exit_idle"]);
});

test("exit waits until Com has acked every request (checklist step 3) and checkpoints only then", async () => {
  const w = new World({ comAcks: false });
  w.say("hi", "u1");
  let done = false;
  const p = w.run().then((r) => { done = true; return r; });
  await sleep(150);
  assert.equal(done, false, "still waiting for the ack");
  assert.equal(await w.latest(), null, "no checkpoint before the ack");
  w.bus.connect("com").onMessage(() => {}); // Com wakes and acks
  const r = await p;
  assert.equal(r.exit, "idle");
  assert.equal(await w.latest(), 1);
});

test("a message during the final poll goes back to step 1 and is handled in the same run", async () => {
  const ops: string[] = [];
  const { wrapComms } = recorder(ops);
  let w!: World;
  let sent = false;
  w = new World({
    wrapComms: (c) => wrapComms(c, () => {
      if (!sent) { sent = true; w.say("one more thing", "u2"); }
    }),
  });
  w.say("hi", "u1");
  const r = await w.run();
  assert.equal(r.exit, "idle");
  assert.equal(r.processed, 2);
  const log = await w.log();
  assert.equal(lifecycle(log, "checkpoint").length, 2, "checkpointed again after the late message");
  assert.equal(lifecycle(log, "exit_idle").length, 1);
  assert.equal(w.primeQueue().length, 0, "both messages deleted");
  // u2 arrived while the model call for u1 was in flight: it waits for the reply.
  assert.equal((await w.takeRequests()).length, 1);
});

test("continuation at the run deadline: no new model calls, late messages absorbed, self-wake sent last", async () => {
  let clock = Date.parse("2026-11-21T00:00:00Z");
  const ops: string[] = [];
  const { wrapStore, wrapComms } = recorder(ops);
  const wakes: unknown[] = [];
  let advanced = false;
  // Building the first model request "takes" 12.5 minutes: past the 12-min deadline, before the absorb cut-off (14 min − 60 s).
  const slow: ModelAdapter = {
    provider: adapter.provider,
    toRequest: (req) => { if (!advanced) { advanced = true; clock += 12.5 * 60_000; } return adapter.toRequest(req); },
    fromResponse: (b) => adapter.fromResponse(b),
  };
  const w = new World({
    now: () => new Date(clock),
    wrapStore,
    wrapComms: (c) => wrapComms(c),
    deps: { adapter: slow, selfWake: async (e) => { ops.push("selfWake"); wakes.push(e); } },
  });
  w.say("first", "u1");
  w.say("second", "u2");
  const r = await w.run();
  assert.equal(r.exit, "deadline");
  assert.deepEqual(wakes, [{ reason: "continue" }]);
  assert.equal(ops.at(-1), "selfWake", "the self-wake is the very last action");
  const latestAt = ops.lastIndexOf("put prime/latest.json");
  const firstDelete = ops.findIndex((o) => o.startsWith("sqs-delete"));
  assert.ok(latestAt < firstDelete && firstDelete < ops.indexOf("selfWake"), ops.join("\n"));
  const log = await w.log();
  assert.equal(kinds(log).at(-1), "lifecycle:exit_deadline");
  assert.equal(w.primeQueue().length, 0, "u2 was absorbed into the checkpoint and deleted");
  const [m1, ...rest] = await w.takeRequests();
  assert.equal(rest.length, 0, "only the call started before the deadline");

  // The continuation run picks up: once the first reply lands, it comes before u2, and u2 gets its own call.
  const ctx1 = (await w.state()).model_context as Message[];
  assert.deepEqual(ctx1.map((m) => (m.content[0] as { text: string }).text), ["first", "second"]);
  await w.respond(m1!.body.request_id, anthropic([{ type: "text", text: "reply to first" }]));
  const r2 = await w.run("continue");
  assert.equal(r2.exit, "idle");
  const [m2] = await w.takeRequests();
  const sent = (await w.requestBody(m2!)) as { messages: { role: string; content: { text: string }[] }[] };
  assert.deepEqual(sent.messages.map((m) => [m.role, m.content[0]!.text]), [
    ["user", "first"], ["assistant", "reply to first"], ["user", "second"],
  ]);
});

test("a reply to a model call goes before user messages that arrived while it was in flight", async () => {
  const w = new World();
  w.say("q1", "u1");
  await w.run();
  const [m1] = await w.takeRequests();
  w.say("q2", "u2");
  await w.run(); // u2 lands while the call for u1 is pending
  await w.respond(m1!.body.request_id, anthropic([{ type: "text", text: "a1" }]));
  await w.run();
  const ctx = (await w.state()).model_context as Message[];
  assert.deepEqual(ctx.map((m) => [m.role, (m.content[0] as { text: string }).text]), [["user", "q1"], ["assistant", "a1"], ["user", "q2"]]);
  assert.ok(ctx.every((m) => m.queued === undefined));
  assert.equal((await w.takeRequests()).length, 1, "q2 gets its own model call");
});

test("a response already waiting is used even if its request is just past the lost deadline (#0015 review)", async () => {
  let clock = Date.parse("2026-11-21T00:00:00Z");
  const w = new World({ now: () => new Date(clock) });
  w.say("go", "u1");
  await w.run();
  const [m1] = await w.takeRequests();
  await w.respond(m1!.body.request_id, toolUse("c1", `return (await fetch("https://e.com/slow")).text()`));
  await w.run();
  const [f1] = await w.takeRequests();
  clock += (600 + 61) * 1000; // past timeout_s + 60…
  await w.respond(f1!.body.request_id, "made it"); // …but the response is already queued
  await w.run();
  const ctx = (await w.state()).model_context as Message[];
  assert.equal(JSON.parse((ctx[2]!.content[0] as { content: string }).content).value, "made it");
  assert.equal((await w.log()).filter((e) => e.kind === "error").length, 0, "nothing declared lost");
});

test("a malformed workspace/ key is skipped and logged; Prime still starts (#0015 review)", async () => {
  const w = new World();
  w.say("hi", "u1");
  await w.run();
  await w.store.put("workspace/../evil.txt", "x");
  await w.store.put("workspace/ok.txt", "fine");
  w.say("again", "u2");
  const r = await w.run();
  assert.equal(r.exit, "idle");
  const restore = lifecycle(await w.log(), "restore").at(-1)!;
  const body = restore.body as { workspace_files: number; workspace_skipped: { key: string }[] };
  assert.equal(body.workspace_files, 1);
  assert.deepEqual(body.workspace_skipped.map((s) => s.key), ["workspace/../evil.txt"]);
  assert.equal(existsSync(join(w.workspaceDir, "..", "evil.txt")), false);
});

test("late in the run (13.5 min), inbound messages are still absorbed, never left invisible in SQS (#0029, #0016 review)", async () => {
  let clock = Date.parse("2026-11-21T00:00:00Z");
  let advanced = false;
  const slow: ModelAdapter = {
    provider: adapter.provider,
    toRequest: (req) => { if (!advanced) { advanced = true; clock += 13.5 * 60_000; } return adapter.toRequest(req); },
    fromResponse: (b) => adapter.fromResponse(b),
  };
  const wakes: unknown[] = [];
  const w = new World({ now: () => new Date(clock), deps: { adapter: slow, selfWake: async (e) => { wakes.push(e); } } });
  w.say("first", "u1");
  w.say("second", "u2");
  const r = await w.run();
  assert.equal(r.exit, "deadline");
  assert.equal(r.processed, 2);
  assert.deepEqual(w.primeQueue(), [], "both deleted after the checkpoint");
  assert.deepEqual(((await w.state()).model_context as Message[]).length, 2);
  assert.equal(wakes.length, 1);
});
