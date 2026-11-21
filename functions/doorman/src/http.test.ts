import { test } from "node:test";
import assert from "node:assert/strict";
import { authorized, json, parseRequest } from "./http.ts";

test("parseRequest decodes base64 bodies and lower-cases headers", () => {
  const r = parseRequest({
    rawPath: "/messages",
    headers: { "Content-Type": "application/json", AUTHORIZATION: "Bearer x" },
    body: Buffer.from('{"a":1}').toString("base64"),
    isBase64Encoded: true,
    requestContext: { http: { method: "post" } },
  });
  assert.equal(r.method, "POST");
  assert.equal(r.body, '{"a":1}');
  assert.equal(r.headers["content-type"], "application/json");
  assert.equal(r.headers["authorization"], "Bearer x");
});

test("authorized: exact bearer token only", () => {
  const req = (h?: string) => parseRequest(h === undefined ? {} : { headers: { authorization: h } });
  assert.equal(authorized(req("Bearer tok"), "tok"), true);
  assert.equal(authorized(req("Bearer tok2"), "tok"), false);
  assert.equal(authorized(req("Bearer to"), "tok"), false);
  assert.equal(authorized(req("tok"), "tok"), false);
  assert.equal(authorized(req(), "tok"), false);
  assert.equal(authorized(req("Bearer "), ""), false);
});

test("json sets content-type", () => {
  assert.deepEqual(json(200, { a: 1 }), { statusCode: 200, headers: { "content-type": "application/json" }, body: '{"a":1}' });
});
