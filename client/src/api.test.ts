import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { Api, ApiError, POST_BACKOFF_MS } from "./api.ts";
import { FakeDoorman } from "./fake-doorman.ts";

const TOKEN = "s3cret-token-value";
let fake: FakeDoorman;
afterEach(() => fake?.stop());

async function setup() {
  fake = await new FakeDoorman().start();
  const slept: number[] = [];
  const api = new Api({ baseUrl: fake.url, token: TOKEN, sleep: async (ms) => void slept.push(ms) });
  return { api, slept };
}

test("(a) 503, 503, 202 → three POSTs with the same msg_id, attempts 3, backoff 1 s then 2 s", async () => {
  const { api, slept } = await setup();
  fake.postStatuses = [503, 503, 202];
  const r = await api.postMessage("hi");
  assert.equal(r.attempts, 3);
  const posts = fake.requests.filter((x) => x.path === "/messages");
  assert.equal(posts.length, 3);
  assert.deepEqual(new Set(posts.map((p) => (p.body as { msg_id: string }).msg_id)), new Set([r.msg_id]));
  assert.deepEqual(slept, [1000, 2000]);
});

test("503 forever → ApiError after 6 attempts", async () => {
  const { api, slept } = await setup();
  fake.postStatuses = [503];
  await assert.rejects(api.postMessage("hi", "m1"), (e: unknown) => e instanceof ApiError && e.status === 503);
  assert.equal(fake.requests.length, 6);
  assert.deepEqual(slept, POST_BACKOFF_MS);
});

test("(b) 401 throws without retrying", async () => {
  const { api } = await setup();
  fake.postStatuses = [401];
  await assert.rejects(api.postMessage("hi"), (e: unknown) => e instanceof ApiError && e.status === 401);
  assert.equal(fake.requests.length, 1);
});

test("(c) every request carries the bearer header; the token is in no error", async () => {
  const { api } = await setup();
  await api.wake();
  await api.postMessage("hi");
  await api.events(-1);
  assert.ok(fake.requests.every((r) => r.auth === `Bearer ${TOKEN}`));
  assert.equal(fake.requests[2]!.path, "/events?after=-1&limit=200", "trailing slash trimmed");
  fake.postStatuses = [400];
  const err = await api.postMessage("x").catch((e: Error) => e);
  assert.ok(err instanceof Error && !err.message.includes(TOKEN));
  const dead = new Api({ baseUrl: "http://127.0.0.1:1", token: TOKEN, sleep: async () => {} });
  const net = await dead.postMessage("x").catch((e: Error) => e);
  assert.ok(net instanceof ApiError && net.status === null && !net.message.includes(TOKEN));
});
