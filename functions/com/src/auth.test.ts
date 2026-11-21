import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAuth, cachedSecrets, openaiKeyFor, UnsupportedAuth, type ModelSecret } from "./auth.ts";
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

test("auth: bedrock is unsupported", async () => {
  await assert.rejects(applyAuth(req("bedrock"), cachedSecrets(async () => secret)), UnsupportedAuth);
});

test("auth: the secret is fetched once per run", async () => {
  let n = 0;
  const s = cachedSecrets(async () => (n++, secret));
  await Promise.all([applyAuth(req("anthropic"), s), applyAuth(req("anthropic"), s)]);
  await applyAuth(req("anthropic"), s);
  assert.equal(n, 1);
});
