// Spike S1 checks (#0011, spec §10). Run: spikes/s1-quickjs/run.sh
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { QuickJS } from "./quickjs.ts";
import { PRELUDE, hostFunctions, loadWasm, wrapEval, type HostLog } from "./harness.ts";

const wasm = loadWasm();

/** Boot, define state, start an eval that awaits a fetch, and snapshot mid-await. */
async function makeSnapshot() {
  const log: HostLog = { fetches: [], logs: [] };
  const q = await QuickJS.boot(wasm, hostFunctions(log));
  q.eval(PRELUDE);
  // State the model built up in earlier turns: a function, a global let, an array.
  q.eval(`function greet(name) { return "hello " + name; }`);
  q.eval(`let counter = 41; var notes = ["a", "b"];`);
  // The scale-to-zero case: an eval suspended on a fetch that Com will answer later.
  q.eval(wrapEval("e1", `const body = await fetch("mock://slow?seconds=90"); counter++; return greet(body) + " " + counter;`));
  q.runJobs();
  const t0 = performance.now();
  const snap = q.snapshot();
  const snapshotMs = performance.now() - t0;
  return { q, log, snap, snapshotMs, memoryBytes: q.memoryBytes() };
}

test("an eval awaiting fetch is pending at snapshot time, with the request at the host", async () => {
  const { q, log } = await makeSnapshot();
  assert.deepEqual(JSON.parse(q.eval(`JSON.stringify(__evals.e1)`)), { status: "pending" });
  assert.deepEqual(log.fetches, [{ id: "r1", url: "mock://slow?seconds=90" }]);
});

test("restore in a new process: state survives, the pending fetch resolves, host functions work", async (t) => {
  const { snap, snapshotMs, memoryBytes } = await makeSnapshot();
  const dir = mkdtempSync(join(tmpdir(), "s1-"));
  const file = join(dir, "repl.bin");
  writeFileSync(file, snap);

  const out = execFileSync(process.execPath, [new URL("./child.ts", import.meta.url).pathname, file], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const r = JSON.parse(out.trim().split("\n").pop()!);

  // Check 1: variables and functions defined before the snapshot.
  assert.deepEqual(r.state, { greet: "function", hello: "hello again", counter: 41, notes: "a,b" });
  // Check 2: the promise pending before the snapshot resolves after restore.
  assert.deepEqual(r.before, { status: "pending" });
  assert.ok(r.jobs > 0, "resolving ran promise jobs");
  assert.deepEqual(r.after, { status: "done", value: "hello world 42" });
  // Check 3: host functions, re-registered in the same order, still work,
  // and the request counter (JS state) continued from the snapshot.
  assert.deepEqual(r.hostLogs, ["log after restore"]);
  assert.deepEqual(r.hostFetches, [{ id: "r2", url: "mock://second" }]);
  assert.deepEqual(r.e2, { status: "pending" });

  // Check 4: size and time.
  t.diagnostic(`linear memory ${memoryBytes} bytes; snapshot (gzip -1) ${snap.length} bytes`);
  t.diagnostic(`snapshot ${snapshotMs.toFixed(1)} ms; restore in child ${r.restoreMs.toFixed(1)} ms`);
});

test("restore refuses host functions registered in a different order", async () => {
  const { snap } = await makeSnapshot();
  const log: HostLog = { fetches: [], logs: [] };
  const opts = hostFunctions(log);
  const reversed = { ...opts, host: Object.fromEntries(Object.entries(opts.host).reverse()) };
  await assert.rejects(QuickJS.restore(wasm, snap, reversed), /same order/);
});

test("one snapshot restores into independent instances", async () => {
  const { snap } = await makeSnapshot();
  const a = await QuickJS.restore(wasm, snap, hostFunctions({ fetches: [], logs: [] }));
  const b = await QuickJS.restore(wasm, snap, hostFunctions({ fetches: [], logs: [] }));
  a.eval(`counter = 100`);
  assert.equal(a.eval(`counter`), "100");
  assert.equal(b.eval(`counter`), "41");
});

test("the interrupt handler stops a runaway eval (CPU limit), also after restore", async () => {
  let deadline = Infinity;
  const opts = { ...hostFunctions({ fetches: [], logs: [] }), shouldInterrupt: () => Date.now() > deadline };
  const q = await QuickJS.boot(wasm, opts);
  deadline = Date.now() + 200;
  assert.throws(() => q.eval(`for (;;) {}`), /interrupted/);

  const restored = await QuickJS.restore(wasm, q.snapshot(), opts);
  deadline = Date.now() + 200;
  assert.throws(() => restored.eval(`while (true) {}`), /interrupted/);
  assert.equal(restored.eval(`1 + 1`), "2", "the instance is usable after an interrupt");
});
