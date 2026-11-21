import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryBus, type InMemoryComms } from "../../shared/src/comms.ts";
import { type HttpRequestBody, type HttpResponseBody } from "../../shared/src/envelope.ts";
import { ComCore, type ComDeps, type ComStore } from "./com.ts";
import { cachedSecrets } from "./auth.ts";
import { abortableSleep } from "./mock.ts";

class FakeStore implements ComStore {
  readonly objects = new Map<string, string>();
  readonly streamed: string[] = [];
  async getText(key: string) {
    return this.objects.get(key) ?? null;
  }
  async getJSONOrNull<T>(key: string) {
    const s = this.objects.get(key);
    return s === undefined ? null : (JSON.parse(s) as T);
  }
  async putStream(key: string, body: ReadableStream<Uint8Array>) {
    this.streamed.push(key);
    const chunks: Uint8Array[] = [];
    for await (const c of body) chunks.push(c);
    this.objects.set(key, Buffer.concat(chunks).toString("utf8"));
  }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 5));
async function until(cond: () => boolean, ms = 2000) {
  for (let t = 0; t < ms && !cond(); t += 5) await tick();
  assert.ok(cond(), "condition not met in time");
}

let toStop: InMemoryComms[] = [];
afterEach(async () => {
  for (const c of toStop) await c.stop();
  toStop = [];
});

function setup(over: Partial<ComDeps> = {}) {
  const bus = new InMemoryBus();
  const prime = bus.connect("prime");
  const responses: HttpResponseBody[] = [];
  prime.onMessage((d) => {
    if (d.msg.type === "http.response") responses.push(d.msg.body);
    void prime.deleteMessage(d.receipt);
  });
  const comms = bus.connect("com");
  toStop.push(prime, comms);
  const store = new FakeStore();
  const fetched: { url: string; init: RequestInit | undefined }[] = [];
  const logs: Record<string, unknown>[] = [];
  const deps: ComDeps = {
    comms,
    store,
    secrets: cachedSecrets(async () => ({ anthropic: "k" })),
    fetch: (async (url: string, init?: RequestInit) => {
      fetched.push({ url, init });
      return new Response("hello world", { status: 200, headers: { "content-type": "text/plain", "x-request-id": "x1" } });
    }) as typeof fetch,
    sleep: abortableSleep,
    now: Date.now,
    log: (e) => logs.push(e),
    runEndsAtMs: Date.now() + 15 * 60_000,
    checkEveryMs: 5,
    finalPollMs: 20,
    ...over,
  };
  const core = new ComCore(deps);
  return { bus, prime, comms, core, store, responses, fetched, logs };
}

function req(over: Partial<HttpRequestBody> = {}): HttpRequestBody {
  return { request_id: "req-1", method: "GET", url: "https://example.com/x", headers: {}, auth: "none", timeout_s: 10, purpose: "repl", ...over };
}

test("success: body streamed to S3, byte count, one terminal response, deleted on accept", async () => {
  const s = setup();
  s.prime.send("com", "http.request", req());
  await until(() => s.responses.length === 1);
  const r = s.responses[0]!;
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.body_ref, "bodies/req-1.res");
  assert.equal(r.bytes, 11);
  assert.deepEqual(r.headers, { "content-type": "text/plain", "x-request-id": "x1" });
  assert.deepEqual(s.store.streamed, ["bodies/req-1.res"]);
  assert.equal(s.store.objects.get("bodies/req-1.res"), "hello world");
  assert.equal(s.bus.pending("com").filter((m) => m.type === "http.request").length, 0, "deleted on accept");
});

test("request body is read from body_ref and sent; auth applied", async () => {
  const s = setup();
  s.store.objects.set("bodies/req-1.req", '{"a":1}');
  s.prime.send("com", "http.request", req({ method: "POST", body_ref: "bodies/req-1.req", auth: "anthropic" }));
  await until(() => s.responses.length === 1);
  assert.equal(s.fetched[0]!.init!.body, '{"a":1}');
  assert.equal((s.fetched[0]!.init!.headers as Record<string, string>)["x-api-key"], "k");
});

test("dedupe: the same request_id twice → one fetch, one response", async () => {
  const s = setup();
  s.prime.send("com", "http.request", req());
  s.prime.send("com", "http.request", req());
  await until(() => s.responses.length === 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.fetched.length, 1);
  assert.equal(s.responses.length, 1);
  assert.equal(s.bus.pending("com").filter((m) => m.type === "http.request").length, 0);
});

test("HTTP 500: terminal ok:false with status and body", async () => {
  const s = setup({ fetch: (async () => new Response("boom", { status: 500 })) as typeof fetch });
  s.prime.send("com", "http.request", req());
  await until(() => s.responses.length === 1);
  assert.equal(s.responses[0]!.ok, false);
  assert.equal(s.responses[0]!.status, 500);
  assert.equal(s.store.objects.get("bodies/req-1.res"), "boom");
});

test("timeout: terminal ok:false 'timeout after Ns'", async () => {
  const s = setup();
  s.prime.send("com", "http.request", req({ url: "mock://slow?seconds=5", timeout_s: 0.05 }));
  await until(() => s.responses.length === 1);
  assert.deepEqual([s.responses[0]!.ok, s.responses[0]!.error], [false, "timeout after 0.05s"]);
});

test("network error and bedrock: terminal ok:false with the error", async () => {
  const s = setup({ fetch: (async () => { throw new Error("ECONNRESET"); }) as typeof fetch });
  s.prime.send("com", "http.request", req());
  s.prime.send("com", "http.request", req({ request_id: "req-2", auth: "bedrock" }));
  await until(() => s.responses.length === 2);
  const byId = Object.fromEntries(s.responses.map((r) => [r.request_id, r.error]));
  assert.deepEqual(byId, { "req-1": "ECONNRESET", "req-2": "bedrock auth not implemented" });
});

test("mock model via Com, with delay scale", async () => {
  const s = setup({ delayScale: 0.0001 });
  s.store.objects.set("bodies/req-1.req", JSON.stringify({ model: "mock", messages: [{ role: "user", content: "hi" }] }));
  s.prime.send("com", "http.request", req({ url: "mock://model", auth: "mock", body_ref: "bodies/req-1.req", purpose: "model" }));
  await until(() => s.responses.length === 1);
  assert.equal(JSON.parse(s.store.objects.get("bodies/req-1.res")!).stop_reason, "tool_use");
});

test("other message types are logged and deleted", async () => {
  const s = setup();
  s.prime.send("com", "user.message", { text: "?" });
  await until(() => s.logs.some((l) => l["kind"] === "unexpected"));
  await tick();
  assert.equal(s.bus.pending("com").filter((m) => m.type === "user.message").length, 0);
});

test("run(): exits only when nothing is in flight, nothing unacked and the final poll is empty", async () => {
  const s = setup();
  s.prime.send("com", "http.request", req({ url: "mock://slow?seconds=0.05" }));
  await until(() => s.core.inFlightCount === 1);
  // Prime goes to sleep: the response will stay unacked until Prime is back.
  await s.prime.stop();
  let done = false;
  const run = s.core.run().then((x) => ((done = true), x));
  await until(() => s.core.inFlightCount === 0);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(done, false, "must not exit while the response is unacked");
  assert.equal(s.comms.unackedCount(), 1);
  const prime2 = s.bus.connect("prime");
  toStop.push(prime2);
  prime2.onMessage((d) => void prime2.deleteMessage(d.receipt));
  assert.equal(await run, "idle");
  assert.equal(s.comms.unackedCount(), 0);
});

test("run(): near the run deadline, aborts in-flight work and exits", async () => {
  const s = setup({ runEndsAtMs: Date.now() + 10_050 });
  s.prime.send("com", "http.request", req({ url: "mock://slow?seconds=60", timeout_s: 120 }));
  await until(() => s.core.inFlightCount === 1);
  assert.equal(await s.core.run(), "deadline");
  assert.ok(s.logs.some((l) => l["kind"] === "exit_deadline"));
});

