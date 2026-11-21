import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { Api } from "./api.ts";
import { ev, FakeDoorman } from "./fake-doorman.ts";
import { isEndOfTurn, runTurn } from "./turn.ts";
import { tail } from "./cli.ts";

let fake: FakeDoorman;
afterEach(() => fake?.stop());

async function setup() {
  fake = await new FakeDoorman().start();
  const slept: number[] = [];
  const sleep = async (ms: number) => void slept.push(ms);
  const api = new Api({ baseUrl: fake.url, token: "t", sleep });
  const lines: string[] = [];
  return { api, slept, sleep, lines, print: (l: string) => lines.push(l) };
}

const toolCall = { type: "tool_call", id: "c1", name: "repl", input: { code: "1+1" } };
const text = { type: "text", text: "done" };

test("isEndOfTurn", () => {
  assert.equal(isEndOfTurn(ev(1, "model.response", { body: { content: [text] } })), "end_turn");
  assert.equal(isEndOfTurn(ev(1, "model.response", { body: { content: [text, toolCall] } })), null);
  assert.equal(isEndOfTurn(ev(1, "error", { body: { where: "model.response" } })), "error");
  assert.equal(isEndOfTurn(ev(1, "error", { body: { where: "inbound" } })), null);
  assert.equal(isEndOfTurn(ev(1, "tool.result", { body: {} })), null);
});

test("(d)(g)(j) polls through a tool call to the final response, follows `more`, then stops; no GET during the POST", async () => {
  const s = await setup();
  fake.postDelayMs = 30;
  fake.onPost = (id) => {
    fake.pages = [
      { events: [ev(5, "user.message", { msg_id: id, body: { text: "hi" } })], next_after: 5, more: true },
      { events: [ev(6, "model.response", { body: { content: [toolCall] } })], next_after: 6, more: false },
      { events: [ev(7, "tool.result", { body: { content: "2" } }), ev(8, "model.response", { body: { content: [text] } })], next_after: 8, more: false },
      { events: [ev(9, "lifecycle", { body: { event: "late" } })], next_after: 9, more: false },
    ];
  };
  const r = await runTurn(s.api, "hi", { print: s.print, sleep: s.sleep, after: 4 });
  assert.deepEqual(r, { after: 8, ended: "end_turn" });
  assert.equal(fake.gets().length, 3, "no GET after the end of turn");
  assert.equal(fake.gets()[0]!.path, "/events?after=4&limit=200");
  assert.equal(fake.gets()[1]!.path, "/events?after=5&limit=200");
  assert.deepEqual(s.slept, [1500], "`more` followed without waiting");
  assert.deepEqual(fake.violations, []);
  assert.deepEqual(s.lines, ["you: hi", "→ repl(1+1)", "← 2", "done"]);
});

test("(e) an error at model.response ends the turn", async () => {
  const s = await setup();
  fake.onPost = (id) => {
    fake.pages = [{ events: [ev(1, "user.message", { msg_id: id }), ev(2, "error", { body: { where: "model.response", message: "500" } })], next_after: 2, more: false }];
  };
  assert.deepEqual(await runTurn(s.api, "hi", { print: s.print, sleep: s.sleep }), { after: 2, ended: "error" });
});

test("(f) events from an earlier turn don't end this one; (h) timeout", async () => {
  const s = await setup();
  fake.onPost = () => {
    fake.pages = [
      { events: [ev(1, "user.message", { msg_id: "older" }), ev(2, "model.response", { body: { content: [text] } })], next_after: 2, more: false },
    ];
  };
  let t = 0;
  const r = await runTurn(s.api, "hi", { print: s.print, sleep: async (ms) => void (t += ms), now: () => t, timeoutMs: 10_000 });
  assert.deepEqual(r, { after: 2, ended: "timeout" });
  assert.ok(fake.gets().length >= 2);
});

test("tail pages to the end of the log", async () => {
  const s = await setup();
  fake.pages = [
    { events: [ev(1, "x")], next_after: 1, more: true },
    { events: [ev(2, "x")], next_after: 2, more: false },
  ];
  assert.equal(await tail(s.api), 2);
});
