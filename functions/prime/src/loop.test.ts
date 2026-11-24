// Prime agent loop, log and proxy (#0013). Each "run" is a fresh handler
// invocation that restores from the fake store, as a new Lambda would.
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryBus } from "../../shared/src/comms.ts";
import type { Envelope, EnvelopeFor } from "../../shared/src/envelope.ts";
import { logKey, responseBodyKey } from "../../shared/src/s3-keys.ts";
import type { LogEvent } from "../../shared/src/state.ts";
import { initialState } from "../../shared/src/state.ts";
import { LogWriter } from "./log.ts";
import { Harness, normalize, TOOL_RESULT_LIMIT, toolResultContent } from "./loop.ts";
import { MOCK_URL } from "./models/config.ts";
import type { Message } from "./models/turn.ts";
import { Proxy } from "./proxy.ts";
import type { FetchRequest, Repl } from "./repl/repl.ts";
import { getJSON, MemoryStore } from "./store.ts";
import { adapter, anthropic, kinds, toolUse, World } from "./test-world.ts";

test("one turn spans four runs: model call, tool call whose fetch is answered later, final answer", async () => {
  const w = new World();

  // Run 1: the user's message → one model call, sent without waiting; Prime exits.
  w.say("What is the title of example.com?", "u1");
  const r1 = await w.run();
  assert.equal(r1.restored, false);
  const [m1, ...more1] = await w.takeRequests();
  assert.equal(more1.length, 0);
  assert.equal(m1!.body.purpose, "model");
  assert.equal(m1!.body.auth, "mock");
  assert.equal(m1!.body.url, MOCK_URL);
  const body1 = (await w.requestBody(m1!)) as { messages: unknown[] };
  assert.deepEqual(body1.messages, [{ role: "user", content: [{ type: "text", text: "What is the title of example.com?" }] }]);

  // Run 2: the model asks for a tool call that awaits a fetch → the eval is pending, the fetch goes to Com.
  await w.respond(m1!.body.request_id, toolUse("call_1", `const r = await fetch("https://example.com/"); const html = await r.text(); globalThis.seen = html.length; return html.match(/<title>(.*)<\\/title>/)[1];`));
  const r2 = await w.run();
  assert.equal(r2.restored, true);
  const [f1, ...more2] = await w.takeRequests();
  assert.equal(more2.length, 0);
  assert.equal(f1!.body.purpose, "repl");
  assert.equal(f1!.body.auth, "none");
  assert.equal(f1!.body.url, "https://example.com/");
  assert.equal(f1!.body.request_id, "repl-run2-r1");
  let st = await w.state();
  assert.deepEqual(st.open_tool_calls, ["call_1"]);
  assert.deepEqual(Object.keys(st.pending_requests), ["repl-run2-r1"]);
  assert.equal(st.pending_requests["repl-run2-r1"]!.tool_call_id, "call_1");

  // Run 3: the fetch response settles the eval (restored from the snapshot) → tool result → next model call.
  await w.respond("repl-run2-r1", "<html><title>Example Domain</title></html>");
  await w.run();
  const [m2, ...more3] = await w.takeRequests();
  assert.equal(more3.length, 0);
  assert.equal(m2!.body.purpose, "model");
  const body2 = (await w.requestBody(m2!)) as { messages: { role: string; content: { type: string; content?: string }[] }[] };
  assert.deepEqual(body2.messages.map((m) => m.role), ["user", "assistant", "user"]);
  const result = body2.messages[2]!.content[0]!;
  assert.equal(result.type, "tool_result");
  assert.deepEqual(JSON.parse(result.content!), { value: "Example Domain", stdout: "", stderr: "" });

  // Run 4: the final answer ends the turn.
  await w.respond(m2!.body.request_id, anthropic([{ type: "text", text: "It is “Example Domain”." }]));
  const r4 = await w.run();
  assert.deepEqual(await w.takeRequests(), []);
  st = await w.state();
  assert.deepEqual(st.pending_requests, {});
  assert.deepEqual(st.open_tool_calls, []);
  assert.equal(r4.checkpoint, 4);
  const ctx = st.model_context as Message[];
  assert.deepEqual(ctx.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(ctx[3]!.content, [{ type: "text", text: "It is “Example Domain”." }]);

  // The log: contiguous seqs, no conflicts, and the turn's story in order.
  const log = await w.log();
  assert.deepEqual(log.map((e) => e.seq), log.map((_, i) => i));
  assert.deepEqual(kinds(log), [
    "lifecycle:start", "user.message", "model.request", "http.request", "lifecycle:checkpoint", "lifecycle:exit_idle",
    "lifecycle:start", "lifecycle:restore", "http.response", "model.response", "tool.call", "http.request", "lifecycle:checkpoint", "lifecycle:exit_idle",
    "lifecycle:start", "lifecycle:restore", "http.response", "tool.result", "model.request", "http.request", "lifecycle:checkpoint", "lifecycle:exit_idle",
    "lifecycle:start", "lifecycle:restore", "http.response", "model.response", "lifecycle:checkpoint", "lifecycle:exit_idle",
  ]);
  assert.deepEqual([...new Set(log.map((e) => e.run))], ["run1", "run2", "run3", "run4"]);
  // Messages were deleted after the checkpoints; nothing is left for Prime.
  assert.deepEqual(w.bus.pending("prime").filter((m) => m.type !== "ack"), []);
});

test("a redelivered user.message (same msg_id) is skipped, in the same run and in a later one", async () => {
  const w = new World();
  w.say("hi", "u1");
  w.say("hi", "u1");
  const r1 = await w.run();
  assert.deepEqual({ processed: r1.processed, duplicates: r1.duplicates }, { processed: 1, duplicates: 1 });
  w.say("hi", "u1");
  const r2 = await w.run();
  assert.deepEqual({ processed: r2.processed, duplicates: r2.duplicates }, { processed: 0, duplicates: 1 });
  assert.equal((await w.takeRequests()).length, 1, "one model call in total");
  assert.equal((await w.log()).filter((e) => e.kind === "user.message").length, 1);
});

test("/clear starts a new conversation, keeps the REPL, and drops the old conversation's late response", async () => {
  const w = new World();
  w.say("remember", "u1");
  await w.run();
  const [m1] = await w.takeRequests();
  await w.respond(m1!.body.request_id, toolUse("c1", `globalThis.kept = 42; return "ok"`));
  await w.run();
  const [m2] = await w.takeRequests(); // the model call after the tool result
  w.say("/clear", "u2");
  await w.respond(m2!.body.request_id, anthropic([{ type: "text", text: "late" }]));
  await w.run();
  let st = await w.state();
  assert.equal(st.conv, 1);
  assert.deepEqual(st.model_context, []);
  assert.deepEqual(st.pending_requests, {});
  const log = await w.log();
  const dropped = log.find((e) => e.kind === "http.response" && e.corr_id === m2!.body.request_id)!;
  assert.deepEqual((dropped.body as { dropped: string }).dropped, "unknown request_id");
  assert.equal(log.find((e) => e.kind === "conv.clear")!.conv, 1);

  // The REPL state survived the clear.
  w.say("what was kept?", "u3");
  await w.run();
  const [m3] = await w.takeRequests();
  await w.respond(m3!.body.request_id, toolUse("c2", `return globalThis.kept`));
  await w.run();
  st = await w.state();
  const ctx = st.model_context as Message[];
  assert.deepEqual(ctx[2]!.content[0], { type: "tool_result", tool_call_id: "c2", content: JSON.stringify({ value: "42", stdout: "", stderr: "" }) });
});

test("a failed model call is logged, ends the turn visibly, and is not retried", async () => {
  const w = new World();
  w.say("hi", "u1");
  await w.run();
  const [m1] = await w.takeRequests();
  await w.respond(m1!.body.request_id, "", { ok: false, error: "timeout" });
  await w.run();
  assert.deepEqual(await w.takeRequests(), [], "no retry loop");
  const err = (await w.log()).find((e) => e.kind === "error")!;
  assert.match((err.body as { message: string }).message, /timeout/);
  const ctx = (await w.state()).model_context as Message[];
  assert.equal(ctx.at(-1)!.role, "assistant");
  assert.match((ctx.at(-1)!.content[0] as { text: string }).text, /model call failed: timeout/);
});

test("a non-2xx model response reports the start of its body", async () => {
  const w = new World();
  w.say("hi", "u1");
  await w.run();
  const [m1] = await w.takeRequests();
  await w.respond(m1!.body.request_id, '{"message":"Access denied"}' + "x".repeat(2000), { ok: false, status: 403, errorBody: true });
  await w.run();
  const text = (((await w.state()).model_context as Message[]).at(-1)!.content[0] as { text: string }).text;
  assert.match(text, /request failed \(HTTP 403\): \{"message":"Access denied"\}/);
  assert.ok(text.length < 700, "capped");
});

test("an empty model reply ends the turn visibly and is not sent again", async () => {
  for (const content of [[], [{ type: "text", text: " " }], [{ type: "thinking", thinking: "hm" }]]) {
    const w = new World();
    w.say("hi", "u1");
    await w.run();
    const [m1] = await w.takeRequests();
    await w.respond(m1!.body.request_id, anthropic(content, "max_tokens"));
    await w.run();
    assert.deepEqual(await w.takeRequests(), [], "no billed retry loop");
    const last = ((await w.state()).model_context as Message[]).at(-1)!;
    assert.match((last.content[0] as { text: string }).text, /empty reply \(stop max_tokens\)/);
  }
});

test("a failed REPL fetch rejects inside the REPL and comes back as the tool result", async () => {
  const w = new World();
  w.say("go", "u1");
  await w.run();
  const [m1] = await w.takeRequests();
  await w.respond(m1!.body.request_id, toolUse("c1", `try { await fetch("https://x.invalid/"); } catch (e) { return "caught: " + e.message; }`));
  await w.run();
  const [f1] = await w.takeRequests();
  await w.respond(f1!.body.request_id, "", { ok: false, error: "ENOTFOUND x.invalid" });
  await w.run();
  const ctx = (await w.state()).model_context as Message[];
  const r = ctx[2]!.content[0] as { content: string };
  assert.equal(JSON.parse(r.content).value, "caught: ENOTFOUND x.invalid");
});

// --- Harness units (fake REPL) ---------------------------------------------

function harnessWithFakeRepl() {
  const store = new MemoryStore();
  const state = initialState();
  const bus = new InMemoryBus();
  const comms = bus.connect("prime");
  const log = new LogWriter(store, "run", state);
  const proxy = new Proxy(store, comms, log, state);
  const evals: string[] = [];
  const repl = { eval: (id: string) => { evals.push(id); return { status: "done", value: "1", stdout: "", stderr: "" }; } } as unknown as Repl;
  const outbox: FetchRequest[] = [];
  const h = new Harness({ state, repl, outbox, adapter, proxy, log, run: "run" });
  state.pending_requests["model-0"] = { purpose: "model", sent_at: "", timeout_s: 600 };
  const respond = async (content: unknown[]) => {
    await store.put(responseBodyKey("model-0"), anthropic(content, "tool_use"));
    const msg = { v: 1, msg_id: "m", type: "http.response", from: "com", to: "prime", sent_at: new Date().toISOString(),
      body: { request_id: "model-0", ok: true, status: 200, body_ref: responseBodyKey("model-0"), elapsed_ms: 1 } } as Envelope;
    await h.onHttpResponse(msg as EnvelopeFor<"http.response">);
  };
  return { h, state, evals, respond, store };
}

test("#0014 review: tool-call arguments that weren't valid JSON become a tool error and are never run", async () => {
  const { state, evals, respond } = harnessWithFakeRepl();
  await respond([
    { type: "tool_use", id: "bad", name: "repl", input: { code: '{"code": "process.exit(', _invalid_json: true } },
    { type: "tool_use", id: "nocode", name: "repl", input: {} },
    { type: "tool_use", id: "other", name: "shell", input: { code: "ls" } },
    { type: "tool_use", id: "good", name: "repl", input: { code: "return 1" } },
  ]);
  assert.deepEqual(evals, ["good"], "only the valid call reached the REPL");
  const results = (state.model_context as Message[]).filter((m) => m.role === "user").flatMap((m) => m.content) as { tool_call_id: string; is_error?: boolean; content: string }[];
  assert.deepEqual(results.map((r) => [r.tool_call_id, r.is_error ?? false]), [["bad", true], ["nocode", true], ["other", true], ["good", false]]);
  assert.match(results[0]!.content, /^arguments were not valid JSON: /);
  assert.match(results[2]!.content, /unknown tool "shell"/);
});

test("normalize: merges same-role messages, puts tool results first, drops empty text", () => {
  const out = normalize([
    { role: "user", content: [{ type: "text", text: "a" }] },
    { role: "assistant", content: [{ type: "text", text: " " }, { type: "tool_call", id: "c", name: "repl", input: { code: "1" } }] },
    { role: "user", content: [{ type: "text", text: "while you work…" }] },
    { role: "user", content: [{ type: "tool_result", tool_call_id: "c", content: "{}" }] },
    { role: "assistant", content: [{ type: "text", text: "" }] },
  ]);
  assert.deepEqual(out, [
    { role: "user", content: [{ type: "text", text: "a" }] },
    { role: "assistant", content: [{ type: "tool_call", id: "c", name: "repl", input: { code: "1" } }] },
    { role: "user", content: [{ type: "tool_result", tool_call_id: "c", content: "{}" }, { type: "text", text: "while you work…" }] },
  ]);
});

test("tool results are capped", () => {
  const s = toolResultContent({ status: "done", value: "x".repeat(TOOL_RESULT_LIMIT * 2), stdout: "", stderr: "" });
  assert.ok(s.length < TOOL_RESULT_LIMIT + 100);
  assert.match(s, /\[truncated \d+ chars\]$/);
});

// --- Log ----------------------------------------------------------------------

test("log: an existing seq is never overwritten; the writer takes the next one and records seq_conflict", async () => {
  const store = new MemoryStore();
  await store.put(logKey(5), JSON.stringify({ seq: 5, kind: "lifecycle", run: "lost" }));
  await store.put(logKey(6), JSON.stringify({ seq: 6, kind: "lifecycle", run: "lost" }));
  const log = new LogWriter(store, "now", { next_seq: 5, conv: 2 }, () => new Date("2026-11-20T00:00:00Z"));
  const ev = await log.append("user.message", { msg_id: "u1", body: { text: "hi" } });
  assert.equal(ev.seq, 7);
  assert.equal((await getJSON<LogEvent>(store, logKey(5)))!.run, "lost", "not overwritten");
  assert.deepEqual(await getJSON<LogEvent>(store, logKey(7)), {
    seq: 7, ts: "2026-11-20T00:00:00.000Z", run: "now", conv: 2, kind: "user.message", msg_id: "u1", body: { text: "hi" },
  });
  assert.deepEqual((await getJSON<LogEvent>(store, logKey(8)))!.body, { event: "seq_conflict", wanted: 5, got: 7 });
  assert.equal(log.next, 9);
});

test("bundle: build.mjs copies the QuickJS wasm next to Prime's bundle", async () => {
  const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../../build.mjs", import.meta.url), "utf8"));
  assert.match(src, /copyFileSync\(`\$\{root\}prime\/vendor\/qjs-wasi-reactor\.wasm`, `\$\{root\}dist\/prime\/qjs-wasi-reactor\.wasm`\)/);
});
