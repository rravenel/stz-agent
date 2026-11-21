// Prime checkpoint and restore (#0015, spec §5.4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Comms } from "../../shared/src/comms.ts";
import { logKey } from "../../shared/src/s3-keys.ts";
import type { LogEvent } from "../../shared/src/state.ts";
import type { Message } from "./models/turn.ts";
import { Repl } from "./repl/repl.ts";
import { getText, MemoryStore, type ObjectStore } from "./store.ts";
import { toolUse, anthropic, World } from "./test-world.ts";
import { syncDown, syncUp } from "./workspace-sync.ts";

/** A store that can be told to fail writes, and records every write and delete in order. */
class FaultyStore implements ObjectStore {
  failOn: RegExp | null = null;
  readonly ops: string[];
  private readonly inner: MemoryStore;
  constructor(inner: MemoryStore, ops: string[]) {
    this.inner = inner;
    this.ops = ops;
  }
  private check(key: string) {
    if (this.failOn?.test(key)) throw new Error(`injected failure writing ${key}`);
  }
  get(key: string) { return this.inner.get(key); }
  list(prefix: string) { return this.inner.list(prefix); }
  async put(key: string, body: Uint8Array | string) { this.check(key); this.ops.push(`put ${key}`); return this.inner.put(key, body); }
  async putIfAbsent(key: string, body: Uint8Array | string) { this.check(key); return this.inner.putIfAbsent(key, body); }
  async delete(key: string) { this.check(key); this.ops.push(`delete ${key}`); return this.inner.delete(key); }
}

function faultyWorld(extra: { now?: () => Date } = {}) {
  const ops: string[] = [];
  let faulty!: FaultyStore;
  const recordDeletes = (c: Comms): Comms => ({
    get self() { return c.self; },
    send: c.send.bind(c),
    onMessage: c.onMessage.bind(c),
    deleteMessage: async (r: string) => { ops.push(`sqs-delete ${r}`); return c.deleteMessage(r); },
    unackedCount: c.unackedCount.bind(c),
    finalPoll: c.finalPoll.bind(c),
    stop: c.stop.bind(c),
  });
  const w = new World({ wrapStore: (s) => (faulty = new FaultyStore(s, ops)), wrapComms: recordDeletes, ...extra });
  return { w, faulty, ops };
}

/** Run 1: user message → model asks for a tool call that writes a file and awaits a fetch; run 2 leaves it pending. */
async function pendingFetchWithFile(w: World) {
  w.say("save a note, then fetch", "u1");
  await w.run();
  const [m1] = await w.takeRequests();
  await w.respond(m1!.body.request_id, toolUse("c1", `fs.writeFile("notes/a.txt", "hello"); const r = await fetch("https://e.com/x"); return fs.readFile("notes/a.txt") + " " + (await r.text());`));
  await w.run();
  const [f1] = await w.takeRequests();
  return f1!;
}

for (const [what, failOn] of [
  ["the REPL snapshot", /ckpt-\d+\/repl\.bin$/],
  ["a workspace upload", /^workspace\//],
  ["latest.json", /^prime\/latest\.json$/],
] as const) {
  test(`a crash writing ${what} leaves the previous checkpoint in effect and deletes nothing`, async () => {
    const { w, faulty, ops } = faultyWorld();
    w.say("hi", "u1");
    await w.run();
    const [m1] = await w.takeRequests();
    assert.equal(await w.latest(), 1);

    // Run 2 handles the tool call (which writes a file), then fails while checkpointing.
    await w.respond(m1!.body.request_id, toolUse("c1", `fs.writeFile("f.txt", "x"); return 1`));
    faulty.failOn = failOn;
    ops.length = 0;
    await assert.rejects(w.run(), /injected failure/);
    assert.equal(await w.latest(), 1, "latest.json still points at checkpoint 1");
    assert.ok(!ops.some((o) => o.startsWith("sqs-delete")), "no held message deleted");
    assert.equal(w.primeQueue().length, 1, "the http.response is still in the queue");

    // The next run redoes the work from checkpoint 1 and commits checkpoint 2.
    faulty.failOn = null;
    await w.run();
    assert.equal(await w.latest(), 2);
    assert.equal(w.primeQueue().length, 0);
    const ctx = (await w.state()).model_context as Message[];
    assert.deepEqual(ctx.map((m) => m.role), ["user", "assistant", "user"]);
    assert.equal(await getText(w.store, "workspace/f.txt"), "x");
  });
}

test("held messages are deleted only after latest.json is written", async () => {
  const { w, ops } = faultyWorld();
  w.say("hi", "u1");
  await w.run();
  const latestAt = ops.lastIndexOf("put prime/latest.json");
  const deleteAt = ops.findIndex((o) => o.startsWith("sqs-delete"));
  assert.ok(latestAt >= 0 && deleteAt > latestAt, ops.join("\n"));
});

test("restore round trip: a pending fetch resolves in a later run and the workspace comes back (stale local files gone)", async () => {
  const w = new World();
  const f1 = await pendingFetchWithFile(w);
  assert.equal(await getText(w.store, "workspace/notes/a.txt"), "hello");

  // A warm container may keep /tmp: plant junk and a symlink; the restore must clear them.
  writeFileSync(join(w.workspaceDir, "junk.txt"), "stale");
  symlinkSync("/etc", join(w.workspaceDir, "etc-link"));
  await w.respond(f1.body.request_id, "world");
  await w.run();
  const ctx = (await w.state()).model_context as Message[];
  assert.deepEqual(JSON.parse((ctx[2]!.content[0] as { content: string }).content), { value: "hello world", stdout: "", stderr: "" });
  assert.equal(existsSync(join(w.workspaceDir, "junk.txt")), false);
  assert.equal(existsSync(join(w.workspaceDir, "etc-link")), false);
  assert.equal(readFileSync(join(w.workspaceDir, "notes/a.txt"), "utf8"), "hello");
});

test("workspace sync: changed files only, deletes carry over, symlinks never uploaded or followed", async () => {
  const store = new MemoryStore();
  const base = mkdtempSync(join(tmpdir(), "stz-sync-"));
  const dir = join(base, "ws");
  mkdirSync(join(dir, "d"), { recursive: true });
  writeFileSync(join(base, "secret.txt"), "outside");
  writeFileSync(join(dir, "a.txt"), "a");
  writeFileSync(join(dir, "d", "b.txt"), "b");
  symlinkSync(join(base, "secret.txt"), join(dir, "link.txt"));
  symlinkSync(base, join(dir, "dirlink"));

  const manifest = new Map<string, string>();
  const first = await syncUp(store, dir, manifest);
  assert.deepEqual(first, { uploaded: ["a.txt", "d/b.txt"], deleted: [], skipped: ["dirlink", "link.txt"] });
  assert.deepEqual(await store.list("workspace/"), ["workspace/a.txt", "workspace/d/b.txt"]);

  writeFileSync(join(dir, "a.txt"), "a2");
  await import("node:fs").then((fs) => fs.rmSync(join(dir, "d"), { recursive: true }));
  const second = await syncUp(store, dir, manifest);
  assert.deepEqual(second, { uploaded: ["a.txt"], deleted: ["d/b.txt"], skipped: ["dirlink", "link.txt"] });
  assert.deepEqual(await store.list("workspace/"), ["workspace/a.txt"]);
  assert.equal(await getText(store, "workspace/a.txt"), "a2");

  // Down: plain files only, in a fresh directory.
  const down = join(base, "restored");
  const m = await syncDown(store, down);
  assert.deepEqual([...m.keys()], ["a.txt"]);
  assert.ok(lstatSync(join(down, "a.txt")).isFile());

  // A key that would escape the workspace is refused.
  await store.put("workspace/../escape.txt", "x");
  await assert.rejects(syncDown(store, join(base, "again")), /bad workspace path/);
  assert.equal(existsSync(join(base, "escape.txt")), false);
});

test("stale pending requests fail as lost: a REPL fetch rejects into the tool result, a model call ends the turn", async () => {
  let clock = Date.parse("2026-11-21T00:00:00Z");
  const w = new World({ now: () => new Date(clock) });
  const f1 = await pendingFetchWithFile(w);
  void f1; // Com died: this fetch is never answered.
  clock += (600 + 61) * 1000;
  await w.run();
  let st = await w.state();
  assert.deepEqual(st.open_tool_calls, []);
  const ctx = st.model_context as Message[];
  const result = ctx[2]!.content[0] as { content: string; is_error?: boolean };
  assert.match(JSON.parse(result.content).error, /lost: no response within 660 s/);
  const lostEvents = (await w.log()).filter((e) => e.kind === "error" && (e.body as { lost?: boolean }).lost);
  assert.equal(lostEvents.length, 1);

  // The tool result went to the model; that call is lost too.
  const [m2] = await w.takeRequests();
  assert.equal(m2!.body.purpose, "model");
  clock += (600 + 61) * 1000;
  await w.run();
  st = await w.state();
  assert.deepEqual(st.pending_requests, {});
  const last = (st.model_context as Message[]).at(-1)!;
  assert.equal(last.role, "assistant");
  assert.match((last.content[0] as { text: string }).text, /model call failed: lost/);
  assert.deepEqual(await w.takeRequests(), [], "not retried");
});

test("a request younger than its timeout is left alone", async () => {
  let clock = Date.parse("2026-11-21T00:00:00Z");
  const w = new World({ now: () => new Date(clock) });
  await pendingFetchWithFile(w);
  clock += 600 * 1000;
  await w.run();
  assert.equal(Object.keys((await w.state()).pending_requests).length, 1);
});

test("/clear with an eval waiting on a fetch: the eval is discarded and leaves nothing in the snapshot", async () => {
  const w = new World();
  const f1 = await pendingFetchWithFile(w);
  w.say("/clear", "u2");
  await w.respond(f1.body.request_id, "late");
  await w.run();
  const n = (await w.latest())!;
  const repl = await Repl.restore((await w.store.get(`prime/ckpt-${n}/repl.bin`))!, { workspaceDir: join(w.workspaceDir, "..", "inspect") });
  assert.deepEqual(repl.evalIds(), [], "no orphaned __evals entry");
  assert.deepEqual(repl.pendingRequests(), []);
  assert.deepEqual((await w.state()).model_context, []);
});

test("model request id is the seq its model.request event was actually written at", async () => {
  const w = new World();
  // Run 1 logs start (0) and user.message (1); model.request wants 2. Take 2 first.
  await w.store.put(logKey(2), JSON.stringify({ seq: 2, kind: "lifecycle", run: "lost" }));
  w.say("hi", "u1");
  await w.run();
  const [m1] = await w.takeRequests();
  const ev = (await w.log()).find((e: LogEvent) => e.kind === "model.request")!;
  assert.equal(ev.seq, 3);
  assert.equal(m1!.body.request_id, "model-3");
  assert.equal(ev.corr_id, "model-3");
  assert.equal(ev.body_ref, "bodies/model-3.req");
});

test("after a crash, a re-issued REPL fetch gets a new id; the crashed run's late response is dropped", async () => {
  const { w, faulty } = faultyWorld();
  w.say("fetch", "u1");
  await w.run();
  const [m1] = await w.takeRequests();
  await w.respond(m1!.body.request_id, toolUse("c1", `return (await fetch("https://e.com/x")).text()`));

  // Run 2 sends the fetch, then crashes before its checkpoint commits.
  faulty.failOn = /^prime\/latest\.json$/;
  await assert.rejects(w.run(), /injected failure/);
  const [lostReq] = await w.takeRequests();
  faulty.failOn = null;

  // Run 3 redoes the work from checkpoint 1 and re-issues the fetch under its own id.
  await w.run();
  const [again] = await w.takeRequests();
  assert.equal(lostReq!.body.url, again!.body.url);
  assert.notEqual(lostReq!.body.request_id, again!.body.request_id);
  assert.match(again!.body.request_id, /^repl-run3-r1$/);

  // Com answers both; only run 3's request counts.
  await w.respond(lostReq!.body.request_id, "from the crashed run");
  await w.respond(again!.body.request_id, "from run 3");
  await w.run();
  const ctx = (await w.state()).model_context as Message[];
  assert.equal(JSON.parse((ctx[2]!.content[0] as { content: string }).content).value, "from run 3");
  const dropped = (await w.log()).find((e) => e.kind === "http.response" && e.corr_id === lostReq!.body.request_id)!;
  assert.equal((dropped.body as { dropped: string }).dropped, "unknown request_id");
  void anthropic;
});
