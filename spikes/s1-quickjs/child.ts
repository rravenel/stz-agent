// Restores a snapshot in a brand-new process and runs the S1 checks there.
// Usage: node child.ts <snapshot-file>. Prints one JSON line with results.

import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { QuickJS } from "./quickjs.ts";
import { hostFunctions, loadWasm, wrapEval, type HostLog } from "./harness.ts";

const snap = readFileSync(process.argv[2]!);
const wasm = loadWasm();
const log: HostLog = { fetches: [], logs: [] };

const t0 = performance.now();
const q = await QuickJS.restore(wasm, snap, hostFunctions(log));
const restoreMs = performance.now() - t0;

// 1. Variables and functions defined before the snapshot.
const state = q.eval(`JSON.stringify({ greet: typeof greet, hello: greet("again"), counter, notes: notes.join(",") })`);

// 2. The pending fetch from before the snapshot resolves after restore.
const before = q.eval(`JSON.stringify(__evals.e1)`);
q.eval(`__pending.r1.resolve("world"); delete __pending.r1;`);
const jobs = q.runJobs();
const after = q.eval(`JSON.stringify(__evals.e1)`);

// 3. Host functions still work (re-registered in the same order).
q.eval(`__host_log("log after restore")`);
q.eval(wrapEval("e2", `return await fetch("mock://second")`));
q.runJobs();

console.log(JSON.stringify({
  restoreMs,
  state: JSON.parse(state),
  before: JSON.parse(before),
  jobs,
  after: JSON.parse(after),
  hostLogs: log.logs,
  hostFetches: log.fetches,
  e2: JSON.parse(q.eval(`JSON.stringify(__evals.e2)`)),
}));
