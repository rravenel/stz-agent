// Prime REPL tool (#0012, spec §5.2, §5.3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repl, type FetchRequest, type ReplOptions } from "./repl.ts";
import { QuickJS } from "./quickjs.ts";
import { loadWasm } from "./wasm.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "stz-repl-"));

async function make(extra: ReplOptions = {}) {
  const fetches: FetchRequest[] = [];
  const output: string[] = [];
  const workspaceDir = join(tmp(), "workspace");
  const repl = await Repl.create({
    workspaceDir,
    onFetch: (r) => fetches.push(r),
    onOutput: (s, t) => output.push(`${s}:${t}`),
    ...extra,
  });
  return { repl, fetches, output, workspaceDir };
}

test("settled eval returns value, stdout and stderr", async () => {
  const { repl, output } = await make();
  const r = repl.eval("t1", `console.log("hi", {a: 1}); console.error("warn"); return [1, "two"];`);
  assert.deepEqual(r, { status: "done", value: `[1,"two"]`, stdout: `hi {"a":1}\n`, stderr: "warn\n" });
  assert.deepEqual(output, [`stdout:hi {"a":1}\n`, "stderr:warn\n"]);
  assert.deepEqual(repl.eval("t2", `const x = 1;`), { status: "done", stdout: "", stderr: "" });
  assert.deepEqual(repl.eval("t3", `return "plain"`), { status: "done", value: "plain", stdout: "", stderr: "" });
});

test("thrown errors and syntax errors come back as error, with code positions", async () => {
  const { repl } = await make();
  const r = repl.eval("t1", `throw new TypeError("boom")`);
  assert.equal(r.status, "done");
  assert.match((r as { error: string }).error, /^TypeError: boom\n.*<t1>:1:/s);
  const s = repl.eval("t2", `this is not js`);
  assert.match((s as { error: string }).error, /^SyntaxError/);
  assert.deepEqual(repl.eval("t3", `return 1 // trailing comment`).status, "done");
});

test("state persists across evals on globalThis", async () => {
  const { repl } = await make();
  repl.eval("t1", `globalThis.n = 41; globalThis.inc = () => ++n;`);
  assert.equal((repl.eval("t2", `return inc()`) as { value: string }).value, "42");
});

test("pending eval: fetch goes to the proxy, resolves later, result is taken once", async () => {
  const { repl, fetches } = await make();
  const r = repl.eval("t1", `
    const res = await fetch("https://example.com/x", { method: "post", headers: { "X-A": 1 }, body: "q" });
    console.log("status", res.status, res.headers.get("content-type"));
    return (await res.json()).n + 1;`);
  assert.deepEqual(r, { status: "pending" });
  assert.deepEqual(fetches, [{ requestId: "r1", url: "https://example.com/x", method: "POST", headers: { "X-A": "1" }, body: "q" }]);
  assert.deepEqual(repl.pendingRequests(), ["r1"]);
  assert.deepEqual(repl.pendingEvals(), ["t1"]);
  assert.deepEqual(repl.take("t1"), { status: "pending" });

  repl.resolvePending("r1", { status: 200, headers: { "Content-Type": "application/json" }, body: `{"n":41}` });
  assert.deepEqual(repl.take("t1"), { status: "done", value: "42", stdout: "status 200 application/json\n", stderr: "" });
  assert.throws(() => repl.take("t1"), /no eval with id t1/);
  assert.deepEqual(repl.pendingRequests(), []);
  assert.throws(() => repl.resolvePending("r1", { status: 200, body: "" }), /no pending fetch with id r1/);
});

test("rejectPending rejects the fetch; the model can catch it", async () => {
  const { repl } = await make();
  repl.eval("t1", `try { await fetch("https://x.invalid"); } catch (e) { return "caught " + e.message; }`);
  repl.rejectPending("r1", "ENOTFOUND x.invalid");
  assert.deepEqual(repl.take("t1"), { status: "done", value: "caught ENOTFOUND x.invalid", stdout: "", stderr: "" });
});

test("a throwing host function becomes a catchable JS error (fetch rejects, nothing pending)", async () => {
  const { repl } = await make({ onFetch: () => { throw new Error("proxy down"); } });
  const r = repl.eval("t1", `try { await fetch("https://e.com"); } catch (e) { return e.message; }`);
  assert.deepEqual(r, { status: "done", value: "proxy down", stdout: "", stderr: "" });
  assert.deepEqual(repl.pendingRequests(), []);
});

test("CPU limit interrupts a runaway eval, even one that catches, and the REPL stays usable", async () => {
  const { repl } = await make({ cpuLimitMs: 200 });
  for (const code of [`while (true) {}`, `for (;;) { try { while (true) {} } catch {} }`]) {
    const t0 = Date.now();
    const r = repl.eval("loop", code) as { error: string };
    assert.ok(Date.now() - t0 < 5_000, "interrupted promptly");
    assert.match(r.error, /CPU time limit \(200 ms\)/);
  }
  assert.equal((repl.eval("after", `return 1 + 1`) as { value: string }).value, "2");
});

test("CPU limit also applies to code resumed by a fetch response", async () => {
  const { repl } = await make({ cpuLimitMs: 200 });
  repl.eval("t1", `await fetch("https://e.com"); while (true) {}`);
  repl.resolvePending("r1", { status: 200, body: "" });
  const r = repl.take("t1") as { status: string; error: string };
  assert.equal(r.status, "done");
  assert.match(r.error, /interrupted/);
});

test("no timers, and the raw host functions are not reachable from model code", async () => {
  const { repl } = await make();
  const r = repl.eval("t1", `return [typeof setTimeout, typeof setInterval, typeof __host_fetch, typeof __host_fs, typeof __host_log]`);
  assert.equal((r as { value: string }).value, JSON.stringify(Array(5).fill("undefined")));
});

test("fs: /workspace maps to the workspace dir; text round-trips; paths cannot escape", async () => {
  const { repl, workspaceDir } = await make();
  const ok = repl.eval("t1", `
    fs.writeFile("/workspace/a/b.txt", "line1\\u0000x");
    fs.appendFile("a/b.txt", "\\nline2");
    fs.mkdir("c");
    return [fs.readFile("a/b.txt"), fs.readdir(), fs.exists("a/b.txt"), fs.exists("zz"), fs.stat("a").isDirectory];`);
  assert.equal((ok as { value: string }).value, JSON.stringify(["line1\u0000x\nline2", ["a", "c"], true, false, true]));
  assert.equal(readFileSync(join(workspaceDir, "a/b.txt"), "utf8"), "line1\u0000x\nline2");

  mkdirSync(join(workspaceDir, "..", "outside"), { recursive: true });
  writeFileSync(join(workspaceDir, "..", "outside", "secret"), "s");
  symlinkSync(join(workspaceDir, "..", "outside"), join(workspaceDir, "link"));
  for (const p of ["../outside/secret", "/etc/passwd", "/workspace/../outside/secret", "link/secret"]) {
    const r = repl.eval("t2", `return fs.readFile(${JSON.stringify(p)})`) as { error?: string };
    assert.match(r.error ?? "", /outside \/workspace/, p);
  }
  const missing = repl.eval("t3", `return fs.readFile("nope")`) as { error: string };
  assert.match(missing.error, /ENOENT.*'\/workspace\/nope'/);
  assert.doesNotMatch(missing.error, new RegExp(workspaceDir));
  assert.match((repl.eval("t4", `fs.rm("/workspace")`) as { error: string }).error, /refusing/);
});

test("large file contents round-trip through fs (multi-MB host-call arguments)", async () => {
  const { repl, workspaceDir } = await make();
  const r = repl.eval("t1", `
    const big = "x".repeat(6 * 1024 * 1024) + "end";
    fs.writeFile("big.txt", big);
    fs.writeFile("small.txt", "after");
    return fs.readFile("big.txt").length;`);
  assert.equal((r as { value: string }).value, String(6 * 1024 * 1024 + 3));
  assert.equal(readFileSync(join(workspaceDir, "small.txt"), "utf8"), "after");
});

test("snapshot inside a host call is refused; the Repl is not re-entrant", async () => {
  let repl!: Repl;
  const errors: string[] = [];
  ({ repl } = await make({
    onFetch: () => {
      for (const f of [() => repl.snapshot(), () => repl.eval("inner", "1")]) {
        try { f(); } catch (e) { errors.push((e as Error).message); }
      }
    },
  }));
  repl.eval("t1", `fetch("https://e.com")`);
  assert.equal(errors.length, 2);
  assert.match(errors[0]!, /snapshot\(\) called while QuickJS is running/);
  assert.match(errors[1]!, /not re-entrant/);
  assert.ok(repl.snapshot().length > 0, "fine between calls");
});

test("snapshot → restore in a new process: state survives, the pending eval resolves, ids continue", async () => {
  const { repl, workspaceDir } = await make();
  repl.eval("setup", `globalThis.greet = (n) => "hello " + n; globalThis.counter = 41;`);
  assert.deepEqual(
    repl.eval("e1", `console.log("before"); const r = await fetch("https://e.com/1"); counter++; return greet(await r.text()) + " " + counter;`),
    { status: "pending" },
  );
  const file = join(tmp(), "repl.bin");
  writeFileSync(file, repl.snapshot());

  const out = execFileSync(process.execPath, [new URL("./repl.child.ts", import.meta.url).pathname, file, workspaceDir], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const r = JSON.parse(out.trim().split("\n").pop()!);
  assert.deepEqual(r.before, { pendingRequests: ["r1"], pendingEvals: ["e1"] });
  // Output written before the snapshot is returned with the result after restore.
  assert.deepEqual(r.e1, { status: "done", value: "hello world 42", stdout: "before\n", stderr: "" });
  assert.deepEqual(r.e2, { status: "done", value: `["hello again",42]`, stdout: "", stderr: "" });
  // The request counter lives in the snapshot, so ids stay unique across Prime runs.
  assert.deepEqual(r.fetches.map((f: FetchRequest) => f.requestId), ["r2"]);
});

test("restore in the same process gives an independent instance", async () => {
  const { repl } = await make();
  repl.eval("e1", `globalThis.v = 1; return (await fetch("https://e.com")).status`);
  const snap = repl.snapshot();
  const a = await Repl.restore(snap, { workspaceDir: join(tmp(), "w") });
  const b = await Repl.restore(snap, { workspaceDir: join(tmp(), "w") });
  a.resolvePending("r1", { status: 201, body: "" });
  b.eval("x", `globalThis.v = 2`);
  assert.deepEqual(a.take("e1"), { status: "done", value: "201", stdout: "", stderr: "" });
  assert.deepEqual(b.take("e1"), { status: "pending" });
  assert.equal((a.eval("y", `return v`) as { value: string }).value, "1");
});

test("restore refuses host functions in a different order", async () => {
  const wasm = loadWasm();
  const q = await QuickJS.boot(wasm, { host: { a: () => undefined, b: () => undefined } });
  const snap = q.snapshot();
  await assert.rejects(QuickJS.restore(wasm, snap, { host: { b: () => undefined, a: () => undefined } }), /same order/);
});

test("host-call arguments are read correctly when converting an earlier one grows memory", async () => {
  const seen: string[][] = [];
  let atEntry = 0;
  let q!: QuickJS;
  q = await QuickJS.boot(loadWasm(), {
    host: {
      mem: () => String(q.memoryBytes()),
      echo: (args) => { seen.push(args.map((a) => a.slice(0, 2) + ":" + a.length)); atEntry = q.memoryBytes(); return "ok"; },
    },
  });
  // Use up free heap (allocate until memory grows), so converting the 4M-char
  // argument to UTF-8 (12 MB) inside the host call must grow linear memory
  // before "tail" is read. The spike read argv through a stale DataView here.
  q.eval(`globalThis.big = "€".repeat(4 * 1024 * 1024); globalThis.fill = [];
    { const m0 = +mem(); while (+mem() === m0) fill.push("x".repeat(1 << 16) + fill.length); }`);
  const before = q.memoryBytes();
  assert.equal(q.eval(`echo(big, "tail")`), "ok");
  assert.ok(atEntry > before, `memory grew during the call (${before} -> ${atEntry})`);
  assert.deepEqual(seen, [[`€€:${4 * 1024 * 1024}`, "ta:4"]]);
});
