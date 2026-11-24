import { test } from "node:test";
import assert from "node:assert/strict";
import { cachedSecret, depsFromEnv, loadTokenSecret } from "./aws.ts";

test("depsFromEnv needs the stack's env vars", () => {
  assert.throws(() => depsFromEnv({}), /missing env/);
  const env = {
    API_TOKEN_SECRET_ARN: "arn:t",
    BUCKET_NAME: "b",
    DOORMAN_QUEUE_URL: "https://q/d",
    PRIME_QUEUE_URL: "https://q/p",
    COM_QUEUE_URL: "https://q/c",
    DOORMAN_FUNCTION_NAME: "d",
    PRIME_FUNCTION_NAME: "p",
    COM_FUNCTION_NAME: "c",
  };
  const d = depsFromEnv(env);
  assert.ok(d.comms && d.prime && d.store);
});

test("cachedSecret: one load is shared and cached; a failed load is retried", async () => {
  let n = 0;
  const get = cachedSecret(async () => {
    if (++n === 1) throw new Error("boom");
    return "tok";
  });
  await assert.rejects(get(), /boom/);
  assert.deepEqual(await Promise.all([get(), get()]), ["tok", "tok"]);
  assert.equal(await get(), "tok");
  assert.equal(n, 2);
});

test("loadTokenSecret: reads SecretString; an empty secret is an error", async () => {
  const client = (SecretString?: string) => ({ send: async () => ({ SecretString }) }) as never;
  assert.equal(await loadTokenSecret("arn", client("tok")), "tok");
  await assert.rejects(loadTokenSecret("arn", client()), /empty/);
});
