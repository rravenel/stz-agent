import { test } from "node:test";
import assert from "node:assert/strict";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { LambdaClient } from "@aws-sdk/client-lambda";
import { fromEnv, LambdaWakePort, SqsQueuePort } from "./aws-ports.ts";
import { makeEnvelope, type Envelope } from "./envelope.ts";

const urls = { doorman: "q/d", prime: "q/p", com: "q/c" };
const names = { doorman: "f-d", prime: "f-p", com: "f-c" };

function stub<C>(reply: (cmd: { constructor: { name: string }; input: any }, opts?: any) => unknown) {
  const calls: { name: string; input: any; opts?: any }[] = [];
  const client = { send: async (cmd: any, opts?: any) => (calls.push({ name: cmd.constructor.name, input: cmd.input, opts }), reply(cmd, opts)) };
  return { client: client as unknown as C, calls };
}

test("SqsQueuePort: receive/send/delete hit the right queues", async () => {
  const { client, calls } = stub<SQSClient>((c) =>
    c.constructor.name === "ReceiveMessageCommand" ? { Messages: [{ Body: "x", ReceiptHandle: "r1", Attributes: { ApproximateReceiveCount: "3" } }, { Body: "no-receipt" }] } : {},
  );
  const q = new SqsQueuePort(urls, "com", client);
  assert.deepEqual(await q.receive(5), [{ body: "x", receipt: "r1", receives: 3 }]);
  const msg = makeEnvelope("user.message", "com", "prime", { text: "hi" }) as Envelope;
  await q.send("prime", msg);
  await q.delete("r1");
  await q.release("r1");
  assert.deepEqual(calls[0]!.input, { QueueUrl: "q/c", WaitTimeSeconds: 5, MaxNumberOfMessages: 10, MessageSystemAttributeNames: ["ApproximateReceiveCount"] });
  assert.deepEqual(calls[1]!.input, { QueueUrl: "q/p", MessageBody: JSON.stringify(msg) });
  assert.deepEqual(calls[2]!.input, { QueueUrl: "q/c", ReceiptHandle: "r1" });
  assert.equal(calls[3]!.name, "ChangeMessageVisibilityCommand");
  assert.deepEqual(calls[3]!.input, { QueueUrl: "q/c", ReceiptHandle: "r1", VisibilityTimeout: 0 });
});

test("LambdaWakePort: sync Invoke with abort signal, outcomes classified", async () => {
  let next: () => unknown = () => ({ StatusCode: 200 });
  const { client, calls } = stub<LambdaClient>(() => next());
  const w = new LambdaWakePort(names, 50, client);
  assert.equal((await w.wake("prime")).kind, "started");
  assert.equal(calls[0]!.input.FunctionName, "f-p");
  assert.equal(calls[0]!.input.InvocationType, "RequestResponse");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(calls[0]!.input.Payload)), { reason: "wake" });
  assert.ok(calls[0]!.opts.abortSignal instanceof AbortSignal);
  next = () => ({ StatusCode: 200, FunctionError: "Unhandled" });
  assert.equal((await w.wake("prime")).kind, "failed");
  next = () => {
    throw Object.assign(new Error("busy"), { name: "TooManyRequestsException" });
  };
  assert.equal((await w.wake("prime")).kind, "running");
  next = () => {
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  };
  assert.equal((await w.wake("prime")).kind, "started");
});

test("fromEnv: needs all six vars", () => {
  const env = {
    DOORMAN_QUEUE_URL: "a", PRIME_QUEUE_URL: "b", COM_QUEUE_URL: "c",
    DOORMAN_FUNCTION_NAME: "d", PRIME_FUNCTION_NAME: "e", COM_FUNCTION_NAME: "f",
  };
  assert.ok(fromEnv("com", env).queue instanceof SqsQueuePort);
  assert.throws(() => fromEnv("com", { ...env, COM_QUEUE_URL: "" }), /COM_QUEUE_URL/);
});
