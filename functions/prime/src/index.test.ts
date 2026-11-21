// Prime's Lambda entry point (#0026): real wiring, nothing at import.
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryBus, type Comms } from "../../shared/src/comms.ts";
import { MemoryStore } from "./store.ts";

const env = { BUCKET_NAME: "stz-bucket", PRIME_FUNCTION_NAME: "StzAgent-x-Prime", MODEL_PROVIDER: "mock", MODEL_NAME: "mock" };

function fakes() {
  const calls: string[] = [];
  const bus = new InMemoryBus();
  return {
    calls,
    make: {
      comms: (): Comms => { calls.push("comms"); return bus.connect("prime"); },
      store: (bucket: string) => { calls.push(`store ${bucket}`); return new MemoryStore(); },
      selfWake: (fn: string) => { calls.push(`selfWake ${fn}`); return async () => {}; },
    },
  };
}

test("the module imports with no environment and exports the real handler", async () => {
  const saved = { ...process.env };
  for (const k of [...Object.keys(env), "AWS_REGION"]) delete process.env[k];
  try {
    const m = await import("./index.ts");
    assert.equal(typeof m.handler, "function");
    assert.equal(typeof m.primeDepsFromEnv, "function");
    assert.equal(typeof m.createHandler, "function");
  } finally {
    Object.assign(process.env, saved);
  }
});

test("primeDepsFromEnv wires the bucket, the function name and the model; comms is made per run, not up front", async () => {
  const { primeDepsFromEnv } = await import("./index.ts");
  const { calls, make } = fakes();
  const deps = primeDepsFromEnv(env, make);
  assert.deepEqual(calls, ["store stz-bucket", "selfWake StzAgent-x-Prime"]);
  assert.equal(deps.adapter.provider, "mock");
  assert.equal(typeof deps.selfWake, "function");
  const c1 = deps.comms();
  const c2 = deps.comms();
  assert.notEqual(c1, c2);
  assert.equal(c1.self, "prime");
  assert.deepEqual(calls.slice(2), ["comms", "comms"]);
  await c1.stop();
  await c2.stop();
});

test("missing environment is reported in one error, before any AWS client is made", async () => {
  const { primeDepsFromEnv } = await import("./index.ts");
  const { calls, make } = fakes();
  assert.throws(() => primeDepsFromEnv({ MODEL_PROVIDER: "mock" }, make), /missing environment variables: BUCKET_NAME, PRIME_FUNCTION_NAME/);
  assert.throws(() => primeDepsFromEnv({ ...env, MODEL_PROVIDER: "nope" }, make), /MODEL_PROVIDER/);
  assert.deepEqual(calls, []);
});

test("the handler fails the invocation (not the import) when its environment is missing", async () => {
  const saved = { ...process.env };
  for (const k of Object.keys(env)) delete process.env[k];
  try {
    const { handler } = await import("./index.ts");
    await assert.rejects(handler({ reason: "wake" }, { awsRequestId: "t" }), /missing environment variables: BUCKET_NAME, PRIME_FUNCTION_NAME/);
  } finally {
    Object.assign(process.env, saved);
  }
});

test("a full run through primeDepsFromEnv's wiring (fakes for AWS): one message in, one model request out", async () => {
  const { primeDepsFromEnv, createHandler } = await import("./index.ts");
  const bus = new InMemoryBus();
  const store = new MemoryStore();
  const deps = primeDepsFromEnv(env, {
    comms: () => bus.connect("prime"),
    store: () => store,
    selfWake: () => async () => {},
  });
  const h = createHandler({ ...deps, replOptions: { workspaceDir: `${process.env["TMPDIR"] ?? "/tmp"}/stz-index-${process.pid}` }, idleGraceMs: 5, staleWakeMs: 50, ackPollMs: 2 });
  const client = bus.connect("doorman");
  client.onMessage(() => {});
  bus.connect("com").onMessage(() => {}); // Com acks
  client.send("prime", "user.message", { text: "hi" }, { msg_id: "u1" });
  const r = await h({ reason: "wake" }, { awsRequestId: "run1" });
  assert.equal(r.exit, "idle");
  const reqs = bus.pending("com").filter((m) => m.type === "http.request");
  assert.equal(reqs.length, 1);
  assert.equal((reqs[0]!.body as { auth: string }).auth, "mock");
});
