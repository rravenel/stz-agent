import { test } from "node:test";
import assert from "node:assert/strict";
import { UnackedTracker, WorkerComms } from "./comms-worker.ts";
import type { Delivery } from "./comms.ts";

test("WorkerComms (memory mode): send → delivery reaches the handler → stop resolves", async () => {
  const c = new WorkerComms("prime", { mode: "memory", comms: { tickMs: 20, pollWaitSeconds: 1 }, log: () => {} });
  const got = new Promise<Delivery>((r) => c.onMessage(r));
  const sent = c.send("prime", "user.message", { text: "hi" });
  assert.equal(c.unackedCount(), 1);
  const d = await got;
  assert.equal(d.msg.msg_id, sent.msg_id);
  await c.deleteMessage(d.receipt);
  for (let i = 0; i < 50 && c.unackedCount() > 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(c.unackedCount(), 0, "the self-ack cleared it");
  await c.stop();
});

test("UnackedTracker: a stale push (ack of A) does not hide in-flight send B", () => {
  const u = new UnackedTracker();
  u.posted1(); // send A
  u.push(1, 1); // worker saw A
  assert.equal(u.count(), 1);
  u.posted1(); // send B, still in flight to the worker
  u.push(0, 1); // worker: A acked (pushed before it saw B)
  assert.equal(u.count(), 1, "B still counts");
  u.push(1, 2); // worker saw B
  assert.equal(u.count(), 1);
  u.push(0, 2); // B acked
  assert.equal(u.count(), 0);
});

test("UnackedTracker: ignores an out-of-order older push", () => {
  const u = new UnackedTracker();
  u.posted1();
  u.posted1();
  u.push(2, 2);
  u.push(1, 1);
  assert.equal(u.count(), 2);
});

test("WorkerComms (memory mode): stop() reports an undeleted delivery; one that races stop() never reaches the handler", async () => {
  const opts = { mode: "memory" as const, comms: { tickMs: 20, pollWaitSeconds: 1 }, log: () => {} };
  const a = new WorkerComms("prime", opts);
  const got = new Promise<Delivery>((r) => a.onMessage(r));
  a.send("prime", "user.message", { text: "kept" });
  await got;
  assert.deepEqual(await a.stop(), { released: 1 });

  const b = new WorkerComms("prime", opts);
  let delivered = 0;
  b.onMessage(() => delivered++);
  b.send("prime", "user.message", { text: "races" });
  const r = await b.stop();
  assert.equal(delivered, 0);
  assert.ok(r.released <= 1);
});

test("WorkerComms: calls on a stopped (dead) worker reject instead of hanging", async () => {
  const c = new WorkerComms("prime", { mode: "memory", comms: { tickMs: 20, pollWaitSeconds: 1 }, log: () => {} });
  c.onMessage(() => {});
  await c.stop();
  await assert.rejects(c.stop(), /exited/);
});
