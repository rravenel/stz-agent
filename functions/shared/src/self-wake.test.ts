import { test } from "node:test";
import assert from "node:assert/strict";
import type { InvokeCommand } from "@aws-sdk/client-lambda";
import { makeSelfWake } from "./self-wake.ts";

test("selfWake sends an async Invoke with the event", async () => {
  const sent: InvokeCommand[] = [];
  const wake = makeSelfWake("fn-prime", { send: async (c) => (sent.push(c), { StatusCode: 202 }) });
  await wake({ reason: "continue" });
  const i = sent[0]!.input;
  assert.equal(i.FunctionName, "fn-prime");
  assert.equal(i.InvocationType, "Event");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(i.Payload as Uint8Array)), { reason: "continue" });
});

test("selfWake throws on a non-202 status", async () => {
  const wake = makeSelfWake("fn", { send: async () => ({ StatusCode: 200 }) });
  await assert.rejects(wake({ reason: "continue" }), /status 200/);
});
