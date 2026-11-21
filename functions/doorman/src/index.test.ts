import { test } from "node:test";
import assert from "node:assert/strict";
import { depsFromEnv } from "./aws.ts";

test("depsFromEnv needs the stack's env vars", () => {
  assert.throws(() => depsFromEnv({}), /missing env/);
  const env = {
    API_TOKEN: "t",
    BUCKET_NAME: "b",
    DOORMAN_QUEUE_URL: "https://q/d",
    PRIME_QUEUE_URL: "https://q/p",
    COM_QUEUE_URL: "https://q/c",
    DOORMAN_FUNCTION_NAME: "d",
    PRIME_FUNCTION_NAME: "p",
    COM_FUNCTION_NAME: "c",
  };
  const d = depsFromEnv(env);
  assert.equal(d.token, "t");
  assert.ok(d.comms && d.prime && d.store);
});
