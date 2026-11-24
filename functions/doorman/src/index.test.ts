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

test("depsFromEnv: the token is the secret's value, read once from the configured ARN", async () => {
  const ids: string[] = [];
  const client = { send: async (c: { input: { SecretId: string } }) => (ids.push(c.input.SecretId), { SecretString: "the-secret" }) } as never;
  const url = (q: string) => `https://q/${q}`;
  const d = depsFromEnv(
    {
      API_TOKEN_SECRET_ARN: "arn:t", BUCKET_NAME: "b",
      DOORMAN_QUEUE_URL: url("d"), PRIME_QUEUE_URL: url("p"), COM_QUEUE_URL: url("c"),
      DOORMAN_FUNCTION_NAME: "d", PRIME_FUNCTION_NAME: "p", COM_FUNCTION_NAME: "c",
    },
    client,
  );
  assert.equal(await d.token(), "the-secret");
  assert.equal(await d.token(), "the-secret");
  assert.deepEqual(ids, ["arn:t"]);
});
