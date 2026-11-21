import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAuth, cachedSecrets, openaiKeyFor, type ModelSecret } from "./auth.ts";
import { signBedrock } from "./sigv4.ts";
import type { AuthMode, HttpRequestBody } from "../../shared/src/envelope.ts";

const req = (auth: AuthMode, url = "https://api.anthropic.com/v1/messages"): HttpRequestBody => ({
  request_id: "r", method: "POST", url, headers: { "content-type": "application/json" }, auth, timeout_s: 10, purpose: "model",
});
const secret: ModelSecret = { anthropic: "ak", openai: { "https://api.openai.com": "short", "https://api.openai.com/v1": "long", "https://other.example/v1": "other" } };

test("auth: none/mock pass headers through; anthropic x-api-key; openai bearer", async () => {
  const s = cachedSecrets(async () => secret);
  assert.deepEqual(await applyAuth(req("none"), s), { "content-type": "application/json" });
  assert.deepEqual(await applyAuth(req("mock"), s), { "content-type": "application/json" });
  assert.equal((await applyAuth(req("anthropic"), s))["x-api-key"], "ak");
  assert.equal((await applyAuth(req("openai", "https://api.openai.com/v1/chat/completions"), s))["authorization"], "Bearer long");
});

test("auth: longest-prefix OpenAI key; missing key throws", async () => {
  assert.equal(openaiKeyFor("https://api.openai.com/v2/x", secret.openai), "short");
  assert.equal(openaiKeyFor("https://other.example/v1/chat", secret.openai), "other");
  assert.equal(openaiKeyFor("https://nope.example", secret.openai), null);
  await assert.rejects(applyAuth(req("openai", "https://nope.example"), cachedSecrets(async () => secret)));
});

test("auth: bedrock signs the body and keeps the request headers", async () => {
  const seen: unknown[] = [];
  const signer = { sign: async (r: unknown) => (seen.push(r), { authorization: "AWS4-HMAC-SHA256 sig", "x-amz-date": "d" }) };
  const url = "https://bedrock-runtime.us-west-2.amazonaws.com/model/m/invoke";
  let secretLoads = 0;
  const h = await applyAuth(req("bedrock", url), cachedSecrets(async () => (secretLoads++, secret)), '{"b":1}', signer);
  assert.deepEqual(h, { authorization: "AWS4-HMAC-SHA256 sig", "x-amz-date": "d" });
  assert.deepEqual(seen, [{ method: "POST", url, headers: { "content-type": "application/json" }, body: '{"b":1}' }]);
  assert.equal(secretLoads, 0);
});

test("auth: the secret is fetched once per run", async () => {
  let n = 0;
  const s = cachedSecrets(async () => (n++, secret));
  await Promise.all([applyAuth(req("anthropic"), s), applyAuth(req("anthropic"), s)]);
  await applyAuth(req("anthropic"), s);
  assert.equal(n, 1);
});

test("auth: bedrock with a mixed-case Content-Type sends each header once, as signed", async () => {
  const signer = { sign: (r: Parameters<typeof signBedrock>[0]) => signBedrock(r, { credentials: { accessKeyId: "AKID", secretAccessKey: "SECRET" }, now: new Date("2026-01-01T00:00:00Z") }) };
  const r = { ...req("bedrock", "https://bedrock-runtime.us-west-2.amazonaws.com/model/m/invoke"), headers: { "Content-Type": "application/json", Accept: "application/json" } };
  const h = await applyAuth(r, cachedSecrets(async () => secret), '{"b":1}', signer);
  const keys = Object.keys(h).map((k) => k.toLowerCase());
  assert.equal(new Set(keys).size, keys.length, `duplicate header keys: ${Object.keys(h).join(", ")}`);
  const sent = new Headers(h);
  assert.equal(sent.get("content-type"), "application/json");
  assert.equal(sent.get("accept"), "application/json");
  assert.match(sent.get("authorization")!, /SignedHeaders=accept;content-type;host;x-amz-content-sha256;x-amz-date,/);
});
