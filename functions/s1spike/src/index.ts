// Spike S1 in Lambda (#0020): the #0011 checks, with the snapshot taken in one
// invocation, kept in S3, and restored in another (cold) one.
//   {"mode":"snapshot"}  boot, suspend an eval on a fetch, snapshot to S3
//   {"mode":"restore"}   restore from S3, resolve the fetch, run the checks

import { performance } from "node:perf_hooks";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { hostFunctions, PRELUDE, wrapEval, type HostLog } from "../../../spikes/s1-quickjs/harness.ts";
import { QuickJS } from "../../../spikes/s1-quickjs/quickjs.ts";
import { loadWasm } from "../../prime/src/repl/wasm.ts";

export const KEY = "spikes/s1/snapshot.bin";
const container = Math.random().toString(36).slice(2, 10);
let cold = true;

const timed = async <T>(f: () => T | Promise<T>): Promise<[T, number]> => {
  const t = performance.now();
  const v = await f();
  return [v, Math.round((performance.now() - t) * 10) / 10];
};

export async function takeSnapshot(wasm: Uint8Array) {
  const log: HostLog = { fetches: [], logs: [] };
  const q = await QuickJS.boot(wasm, hostFunctions(log));
  q.eval(PRELUDE);
  q.eval(`function greet(name) { return "hello " + name; }`);
  q.eval(`let counter = 41; var notes = ["a", "b"];`);
  q.eval(wrapEval("e1", `const body = await fetch("mock://slow?seconds=90"); counter++; return greet(body) + " " + counter;`));
  q.runJobs();
  const [snap, snapshotMs] = await timed(() => q.snapshot());
  return { snap, snapshotMs, memoryBytes: q.memoryBytes(), pending: JSON.parse(q.eval(`JSON.stringify(__evals.e1)`)) as { status: string } };
}

/** Restore and run the checks of spikes/s1-quickjs/child.ts. */
export async function restoreAndCheck(wasm: Uint8Array, snap: Uint8Array) {
  const log: HostLog = { fetches: [], logs: [] };
  const [q, restoreMs] = await timed(() => QuickJS.restore(wasm, Buffer.from(snap), hostFunctions(log)));
  const state = JSON.parse(q.eval(`JSON.stringify({ greet: typeof greet, hello: greet("again"), counter, notes: notes.join(",") })`)) as unknown;
  q.eval(`__pending.r1.resolve("world"); delete __pending.r1;`);
  q.runJobs();
  const after = JSON.parse(q.eval(`JSON.stringify(__evals.e1)`)) as unknown;
  q.eval(`__host_log("log after restore")`);
  q.eval(wrapEval("e2", `return await fetch("mock://second")`));
  q.runJobs();
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const checks = {
    state: same(state, { greet: "function", hello: "hello again", counter: 41, notes: "a,b" }),
    pendingFetchResolved: same(after, { status: "done", value: "hello world 42" }),
    hostFunctions: same(log.logs, ["log after restore"]) && same(log.fetches, [{ id: "r2", url: "mock://second" }]),
  };
  return { restoreMs, checks, pass: Object.values(checks).every(Boolean) };
}

export async function handler(event: { mode?: string }) {
  const wasCold = cold;
  cold = false;
  const s3 = new S3Client({});
  const Bucket = process.env["SPIKE_BUCKET"];
  const [wasm, wasmMs] = await timed(() => loadWasm());
  const info = { mode: event.mode, cold: wasCold, container, memoryMb: process.env["AWS_LAMBDA_FUNCTION_MEMORY_SIZE"], node: process.version, wasmMs };
  if (event.mode === "snapshot") {
    const { snap, ...r } = await takeSnapshot(wasm);
    const [, putMs] = await timed(() => s3.send(new PutObjectCommand({ Bucket, Key: KEY, Body: snap })));
    return { ...info, ...r, snapshotBytes: snap.length, putMs };
  }
  if (event.mode === "restore") {
    const [snap, getMs] = await timed(async () => {
      const o = await s3.send(new GetObjectCommand({ Bucket, Key: KEY }));
      return (await o.Body?.transformToByteArray()) ?? new Uint8Array();
    });
    return { ...info, getMs, ...(await restoreAndCheck(wasm, snap)) };
  }
  throw new Error(`mode must be snapshot or restore`);
}
