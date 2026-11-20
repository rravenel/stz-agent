import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryBus, type Delivery } from "./comms.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

test("recipient acks before its handler runs; the ack clears the sender's unacked set", async () => {
  const bus = new InMemoryBus();
  const prime = bus.connect("prime");
  const com = bus.connect("com");
  prime.onMessage(() => {});
  const seen: Delivery[] = [];
  com.onMessage((d) => {
    // The ack is already queued for prime when the handler runs.
    assert.ok(bus.pending("prime").some((m) => m.type === "ack"));
    seen.push(d);
  });

  const sent = prime.send("com", "http.request", {
    request_id: "r1", method: "GET", url: "mock://slow?seconds=1", headers: {}, auth: "none", timeout_s: 5, purpose: "repl",
  });
  assert.equal(prime.unackedCount(), 1);
  await tick();
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.msg.msg_id, sent.msg_id);
  assert.equal(prime.unackedCount(), 0);
  assert.deepEqual(bus.pending("prime"), [], "prime deleted the ack");
});

test("a handled message stays queued until deleteMessage", async () => {
  const bus = new InMemoryBus();
  const doorman = bus.connect("doorman");
  doorman.onMessage(() => {});
  const prime = bus.connect("prime");
  let receipt = "";
  prime.onMessage((d) => (receipt = d.receipt));
  doorman.send("prime", "user.message", { text: "hi" }, { msg_id: "c1" });
  await tick();
  assert.equal(bus.pending("prime").length, 1);
  await prime.deleteMessage(receipt);
  assert.equal(bus.pending("prime").length, 0);
});

test("messages to a sleeping function wait, and an undeleted message is redelivered after a restart", async () => {
  const bus = new InMemoryBus();
  const doorman = bus.connect("doorman");
  doorman.onMessage(() => {});
  doorman.send("prime", "user.message", { text: "hi" }, { msg_id: "c1" });
  await tick();
  assert.equal(doorman.unackedCount(), 1, "prime is asleep: no ack");

  // Prime wakes, receives, but "crashes" before deleting.
  const run1 = bus.connect("prime");
  const got1: string[] = [];
  run1.onMessage((d) => got1.push(d.msg.msg_id));
  await tick();
  assert.deepEqual(got1, ["c1"]);
  assert.equal(doorman.unackedCount(), 0);
  await run1.stop();

  const run2 = bus.connect("prime");
  const got2: string[] = [];
  run2.onMessage((d) => got2.push(d.msg.msg_id));
  await tick();
  assert.deepEqual(got2, ["c1"], "redelivered: dedupe by msg_id is the main thread's job");
});

test("finalPoll reports whether anything arrived during the grace period", async () => {
  const bus = new InMemoryBus();
  const com = bus.connect("com");
  com.onMessage(() => {});
  const prime = bus.connect("prime");
  prime.onMessage(() => {});
  assert.equal(await prime.finalPoll(5), true);

  const poll = prime.finalPoll(20);
  setTimeout(() => com.send("prime", "http.response", { request_id: "r1", ok: true, elapsed_ms: 3 }), 5);
  assert.equal(await poll, false);
});
