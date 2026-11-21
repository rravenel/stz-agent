import { test } from "node:test";
import assert from "node:assert/strict";
import { S3ObjectStore, type S3Like } from "./s3-object-store.ts";

type Handler = (input: Record<string, unknown>) => unknown;

function fake(handlers: Record<string, Handler>): S3Like & { calls: { cmd: string; input: Record<string, unknown> }[] } {
  const calls: { cmd: string; input: Record<string, unknown> }[] = [];
  return {
    calls,
    async send(cmd: unknown) {
      const c = cmd as { constructor: { name: string }; input: Record<string, unknown> };
      calls.push({ cmd: c.constructor.name, input: c.input });
      const h = handlers[c.constructor.name];
      if (!h) throw new Error(`unexpected ${c.constructor.name}`);
      return h(c.input);
    },
  };
}
const err = (name: string, code: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: code } });

test("get returns bytes, null for a missing key, rethrows others", async () => {
  const s = new S3ObjectStore("b", fake({
    GetObjectCommand: (i) => {
      if (i["Key"] === "missing") throw err("NoSuchKey", 404);
      if (i["Key"] === "denied") throw err("AccessDenied", 403);
      return { Body: { transformToByteArray: async () => new TextEncoder().encode("hi") } };
    },
  }));
  assert.equal(new TextDecoder().decode((await s.get("k"))!), "hi");
  assert.equal(await s.get("missing"), null);
  await assert.rejects(s.get("denied"), /AccessDenied/);
});

test("putIfAbsent sets IfNoneMatch and maps 412 to false", async () => {
  let exists = false;
  const f = fake({
    PutObjectCommand: () => {
      if (exists) throw err("PreconditionFailed", 412);
      exists = true;
      return {};
    },
  });
  const s = new S3ObjectStore("b", f);
  assert.equal(await s.putIfAbsent("k", "x"), true);
  assert.equal(await s.putIfAbsent("k", "x"), false);
  assert.equal(f.calls[0]!.input["IfNoneMatch"], "*");
  assert.equal(f.calls[0]!.input["Bucket"], "b");
});

test("putIfAbsent retries a 409 once, then gives false", async () => {
  let n = 0;
  const once = new S3ObjectStore("b", fake({ PutObjectCommand: () => { if (n++ === 0) throw err("ConditionalRequestConflict", 409); return {}; } }));
  assert.equal(await once.putIfAbsent("k", "x"), true);
  const f = fake({ PutObjectCommand: () => { throw err("ConditionalRequestConflict", 409); } });
  assert.equal(await new S3ObjectStore("b", f).putIfAbsent("k", "x"), false);
  assert.equal(f.calls.length, 2);
});

test("list paginates and sorts", async () => {
  const f = fake({
    ListObjectsV2Command: (i) =>
      i["ContinuationToken"] === undefined
        ? { Contents: [{ Key: "p/c" }, { Key: "p/a" }], IsTruncated: true, NextContinuationToken: "t1" }
        : { Contents: [{ Key: "p/b" }], IsTruncated: false },
  });
  assert.deepEqual(await new S3ObjectStore("b", f).list("p/"), ["p/a", "p/b", "p/c"]);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1]!.input["ContinuationToken"], "t1");
  assert.equal(f.calls[0]!.input["Prefix"], "p/");
});

test("put and delete send the right commands", async () => {
  const f = fake({ PutObjectCommand: () => ({}), DeleteObjectCommand: () => ({}) });
  const s = new S3ObjectStore("b", f);
  await s.put("k", "v");
  await s.delete("k");
  assert.deepEqual(f.calls.map((c) => c.cmd), ["PutObjectCommand", "DeleteObjectCommand"]);
  assert.equal(f.calls[0]!.input["IfNoneMatch"], undefined);
});
