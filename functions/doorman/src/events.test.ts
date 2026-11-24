import { test } from "node:test";
import assert from "node:assert/strict";
import { listEvents, parseEventsQuery, type LogStore } from "./events.ts";
import { logKey } from "../../shared/src/s3-keys.ts";
import { route } from "./doorman.ts";
import { ev, TOKEN } from "./testing.ts";

/** In-memory bucket honouring Prefix / StartAfter / MaxKeys like ListObjectsV2. */
function store(objs: Record<string, string>): LogStore & { lists: object[] } {
  const lists: object[] = [];
  return {
    lists,
    async list({ prefix, startAfter, maxKeys }) {
      lists.push({ prefix, startAfter, maxKeys });
      const keys = Object.keys(objs).filter((k) => k.startsWith(prefix) && (startAfter === undefined || k > startAfter)).sort();
      return { keys: keys.slice(0, maxKeys), truncated: keys.length > maxKeys };
    },
    async getText(k) {
      const v = objs[k];
      if (v === undefined) throw new Error("NoSuchKey");
      return v;
    },
  };
}

function bucket(n: number): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < n; i++) o[logKey(i)] = JSON.stringify({ seq: i });
  return o;
}

test("events: empty bucket", async () => {
  assert.deepEqual(await listEvents(store({}), -1, 100), { events: [], next_after: -1, more: false });
  assert.deepEqual(await listEvents(store({}), 7, 100), { events: [], next_after: 7, more: false });
});

test("events: after filters with StartAfter", async () => {
  const s = store(bucket(5));
  const p = await listEvents(s, 2, 100);
  assert.deepEqual(p.events, [{ seq: 3 }, { seq: 4 }]);
  assert.equal(p.next_after, 4);
  assert.deepEqual(s.lists[0], { prefix: "log/", startAfter: logKey(2), maxKeys: 100 });
});

test("events: limit and more page through", async () => {
  const s = store(bucket(5));
  const p1 = await listEvents(s, -1, 2);
  assert.deepEqual(p1, { events: [{ seq: 0 }, { seq: 1 }], next_after: 1, more: true });
  const p3 = await listEvents(s, 3, 2);
  assert.deepEqual(p3, { events: [{ seq: 4 }], next_after: 4, more: false });
});

test("events: non-log keys ignored, corrupt object skipped with a warning", async () => {
  const objs = { ...bucket(3), "log/notes.txt": "x", [logKey(1)]: "{not json" };
  const warns: object[] = [];
  const p = await listEvents(store(objs), -1, 100, (o) => warns.push(o));
  assert.deepEqual(p.events, [{ seq: 0 }, { seq: 2 }]);
  assert.equal(p.next_after, 2);
  assert.equal(warns.length, 1);
});

test("events: query parsing", () => {
  assert.deepEqual(parseEventsQuery({}), { after: -1, limit: 100 });
  assert.deepEqual(parseEventsQuery({ after: "5", limit: "9999" }), { after: 5, limit: 500 });
  for (const after of ["-2", "1.5", "abc", ""]) assert.equal(parseEventsQuery({ after }), null, after);
  assert.equal(parseEventsQuery({ limit: "0" }), null);
});

test("GET /events uses only the store (no comms, no invoker) and rejects bad after", async () => {
  const deps = { token: async () => TOKEN, store: store(bucket(2)), log: () => {} };
  const ok = await route(deps, ev("GET", "/events", { query: { after: "0" } }));
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(JSON.parse(ok.body), { events: [{ seq: 1 }], next_after: 1, more: false });
  assert.equal((await route(deps, ev("GET", "/events", { query: { after: "x" } }))).statusCode, 400);
});
