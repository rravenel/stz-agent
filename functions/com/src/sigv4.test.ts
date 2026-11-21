import { test } from "node:test";
import assert from "node:assert/strict";
import { credsFromEnv, NodeSha256, regionFromBedrockUrl, signBedrock } from "./sigv4.ts";

const URL_ = "https://bedrock-runtime.us-west-2.amazonaws.com/model/anthropic.claude-x/invoke?a=1";
const creds = { accessKeyId: "AKID", secretAccessKey: "SECRET" };
const now = new Date("2026-01-01T00:00:00Z");
const sign = (body: string, c: typeof creds & { sessionToken?: string } = creds) =>
  signBedrock({ method: "POST", url: URL_, headers: { "Content-Type": "application/json" }, body }, { credentials: c, now });

test("signBedrock matches a pinned SigV4 signature", async () => {
  // Golden value cross-checked against an independent SigV4 implementation (Python hmac/hashlib).
  const h = await sign('{"x":1}');
  assert.equal(
    h["authorization"],
    "AWS4-HMAC-SHA256 Credential=AKID/20260101/us-west-2/bedrock/aws4_request, " +
      "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, " +
      "Signature=0e737342602f8857d24a609708b785d18193e5087ea462824107ae228bdf88d7",
  );
  assert.equal(h["x-amz-date"], "20260101T000000Z");
  assert.equal(h["x-amz-content-sha256"], "5041bf1f713df204784353e82f6a4a535931cb64f1f4b4a5aeaffcb720918b22");
  assert.equal(h["host"], "bedrock-runtime.us-west-2.amazonaws.com");
  assert.equal(h["content-type"], "application/json");
});

test("signBedrock: a changed body changes the signature; a session token is signed", async () => {
  const a = (await sign('{"x":1}'))["authorization"]!;
  assert.notEqual((await sign('{"x":2}'))["authorization"], a);
  const t = await sign('{"x":1}', { ...creds, sessionToken: "TOKEN" });
  assert.equal(t["x-amz-security-token"], "TOKEN");
  assert.match(t["authorization"]!, /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token,/);
});

test("regionFromBedrockUrl accepts Bedrock hosts only", () => {
  assert.equal(regionFromBedrockUrl(URL_), "us-west-2");
  assert.equal(regionFromBedrockUrl("https://bedrock.eu-central-1.amazonaws.com/foundation-models"), "eu-central-1");
  assert.throws(() => regionFromBedrockUrl("https://api.anthropic.com/v1/messages"), /not a Bedrock host/);
  assert.throws(() => regionFromBedrockUrl("https://bedrock-runtime.us-west-2.amazonaws.com.evil.example/"), /not a Bedrock host/);
});

test("credsFromEnv needs key id and secret; token optional", () => {
  assert.throws(() => credsFromEnv({}), /credentials are not set/);
  assert.throws(() => credsFromEnv({ AWS_ACCESS_KEY_ID: "a" }), /credentials are not set/);
  assert.deepEqual(credsFromEnv({ AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "s" }), { accessKeyId: "a", secretAccessKey: "s" });
  assert.equal(credsFromEnv({ AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "s", AWS_SESSION_TOKEN: "t" }).sessionToken, "t");
});

test("NodeSha256: hash, HMAC and reset", async () => {
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  const h = new NodeSha256();
  h.update("abc");
  assert.equal(hex(await h.digest()), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  h.reset();
  h.update(new Uint8Array());
  assert.equal(hex(await h.digest()), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  const m = new NodeSha256("key");
  m.update("The quick brown fox jumps over the lazy dog");
  assert.equal(hex(await m.digest()), "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
});
