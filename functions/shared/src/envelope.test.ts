import { test } from "node:test";
import assert from "node:assert/strict";
import { makeAck, makeEnvelope, parseEnvelope, type Envelope, type HttpRequestBody } from "./envelope.ts";

const req: HttpRequestBody = {
  request_id: "req-1",
  method: "POST",
  url: "https://api.example/v1/messages",
  headers: { "content-type": "application/json" },
  body_ref: "bodies/req-1.req",
  auth: "mock",
  timeout_s: 600,
  purpose: "model",
};

test("makeEnvelope fills v, msg_id, sent_at and corr_id from request_id", () => {
  const e = makeEnvelope("http.request", "prime", "com", req, { now: new Date("2026-11-20T00:00:00Z") });
  assert.equal(e.v, 1);
  assert.match(e.msg_id, /^[0-9a-f-]{36}$/);
  assert.equal(e.sent_at, "2026-11-20T00:00:00.000Z");
  assert.equal(e.corr_id, "req-1");
});

test("client-generated msg_id is kept for user.message", () => {
  const e = makeEnvelope("user.message", "doorman", "prime", { text: "hi" }, { msg_id: "client-7" });
  assert.equal(e.msg_id, "client-7");
  assert.equal(e.corr_id, undefined);
});

test("every message type round-trips through JSON", () => {
  const msgs: Envelope[] = [
    makeEnvelope("user.message", "doorman", "prime", { text: "/clear" }),
    makeEnvelope("http.request", "prime", "com", req),
    makeEnvelope("http.response", "com", "prime", { request_id: "req-1", ok: true, status: 200, bytes: 10, elapsed_ms: 91000, body_ref: "bodies/req-1.res" }),
  ];
  msgs.push(makeAck(msgs[1]!));
  for (const m of msgs) {
    const r = parseEnvelope(JSON.stringify(m));
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.deepEqual(r.value, m);
  }
});

test("makeAck swaps direction and points at the acked message", () => {
  const m = makeEnvelope("http.request", "prime", "com", req);
  const a = makeAck(m);
  assert.equal(a.from, "com");
  assert.equal(a.to, "prime");
  assert.equal(a.body.acked_msg_id, m.msg_id);
  assert.equal(a.corr_id, m.msg_id);
});

test("narrowing on type narrows body", () => {
  const r = parseEnvelope(makeEnvelope("ack", "prime", "doorman", { acked_msg_id: "x" }));
  assert.ok(r.ok);
  if (r.value.type === "ack") assert.equal(r.value.body.acked_msg_id, "x");
});

test("parseEnvelope rejects bad shapes without throwing", () => {
  const good = makeEnvelope("http.request", "prime", "com", req) as unknown as Record<string, unknown>;
  const cases: [string, unknown][] = [
    ["not json", "{"],
    ["not an object", "[]"],
    ["version", { ...good, v: 2 }],
    ["msg_id", { ...good, msg_id: "" }],
    ["type", { ...good, type: "http.wat" }],
    ["from", { ...good, from: "browser" }],
    ["sent_at", { ...good, sent_at: "yesterday" }],
    ["auth", { ...good, body: { ...req, auth: "basic" } }],
    ["timeout", { ...good, body: { ...req, timeout_s: 0 } }],
    ["purpose", { ...good, body: { ...req, purpose: "fun" } }],
    ["headers", { ...good, body: { ...req, headers: { a: 1 } } }],
    ["user.message without text", { ...good, type: "user.message", body: { ...req } }],
    ["response ok", { ...good, type: "http.response", body: { request_id: "r", ok: "yes", elapsed_ms: 1 } }],
    ["ack", { ...good, type: "ack", body: {} }],
  ];
  for (const [name, raw] of cases) {
    const r = parseEnvelope(raw);
    assert.equal(r.ok, false, `${name} should be rejected`);
  }
});
