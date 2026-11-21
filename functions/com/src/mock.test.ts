import { test } from "node:test";
import assert from "node:assert/strict";
import { abortableSleep, DEFAULT_SCRIPT, mockRespond, parseSlow, stepIndex, type MockDeps, type MockStep } from "./mock.ts";

function deps(script: MockStep[] | null = null, delayScale = 1) {
  const slept: number[] = [];
  const d: MockDeps = { sleep: async (ms) => void slept.push(ms), loadScript: async () => script, delayScale };
  return { d, slept };
}
const sig = new AbortController().signal;
const body = (assistants: number) =>
  JSON.stringify({ model: "m1", messages: Array.from({ length: assistants * 2 + 1 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x" })) });

test("slow URL: parsed, sleeps N s, returns the body", async () => {
  assert.deepEqual(parseSlow("mock://slow?seconds=90&body=slow-ok"), { seconds: 90, body: "slow-ok" });
  assert.deepEqual(parseSlow("mock://slow"), { seconds: 0, body: "" });
  assert.equal(parseSlow("mock://model"), null);
  const { d, slept } = deps();
  const r = await mockRespond("mock://slow?seconds=3&body=hi", null, d, sig);
  assert.equal(await r.text(), "hi");
  assert.deepEqual(slept, [3000]);
});

test("mock model: step from the assistant-message count; default script; last step repeats", async () => {
  assert.equal(stepIndex(body(0)), 0);
  assert.equal(stepIndex(body(2)), 2);
  assert.equal(stepIndex("not json"), 0);
  const { d, slept } = deps();
  const r0 = (await (await mockRespond("mock://model", body(0), d, sig)).json()) as Record<string, unknown>;
  assert.equal(r0["stop_reason"], "tool_use");
  assert.equal(r0["model"], "m1");
  assert.equal((r0["content"] as { name: string }[])[0]!.name, "repl");
  const r1 = (await (await mockRespond("mock://model", body(1), d, sig)).json()) as Record<string, unknown>;
  assert.equal(r1["stop_reason"], "end_turn");
  const r9 = (await (await mockRespond("mock://model", body(9), d, sig)).json()) as Record<string, unknown>;
  assert.equal(r9["stop_reason"], "end_turn");
  assert.deepEqual(slept, [DEFAULT_SCRIPT[0]!.delay_s * 1000, 5000, 5000]);
});

test("mock model: S3 script override and delay scale", async () => {
  const script: MockStep[] = [{ delay_s: 10, stop_reason: "end_turn", content: [{ type: "text", text: "custom" }] }];
  const { d, slept } = deps(script, 0.1);
  const r = (await (await mockRespond("mock://model", body(0), d, sig)).json()) as { content: { text: string }[] };
  assert.equal(r.content[0]!.text, "custom");
  assert.deepEqual(slept, [1000]);
});

test("unknown mock URL → 404; abortableSleep rejects on abort", async () => {
  assert.equal((await mockRespond("mock://nope", null, deps().d, sig)).status, 404);
  const c = new AbortController();
  const p = abortableSleep(10_000, c.signal);
  c.abort(new Error("stop"));
  await assert.rejects(p, /stop/);
});
