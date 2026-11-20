import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkerComms } from "./comms-worker.ts";
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
