# Spike S1: QuickJS WASM snapshot and restore (#0011)

**Result: it works in plain Node, so no replay fallback is needed.** A QuickJS interpreter, including a REPL eval suspended on a pending `fetch`, can be snapshotted and restored in a **new process**. Functions and variables survive, the pending promise resolves after restore, and host functions keep working.

Run it with `spikes/s1-quickjs/run.sh`, which fetches the pinned wasm and runs `s1.test.ts`. The output is quiet, like `scripts/`.

## Build chosen

- **quickjs-ng v0.18.0, `qjs-wasi-reactor.wasm`**: the official GitHub release asset, pinned by SHA-256 in `fetch-wasm.sh`. It's a WASI *reactor*: it exports the QuickJS C API (`JS_NewRuntime`, `JS_Eval`, `JS_Call`, `JS_NewCFunction2`, `JS_ExecutePendingJob` …) plus `malloc` and `free`, and imports only `wasi_snapshot_preview1`.
- **It isn't an Asyncify build.** All host↔REPL async goes through JS promises (spec §5.2).
- **No npm dependencies.** It runs on `WebAssembly` and a ~40-line WASI shim (`quickjs.ts`): clocks, stdout and stderr, and no files or env. That's deliberately less than Node's `node:wasi`, which would need `_initialize` on restore and would expose host paths.
- **Rejected: quickjs-emscripten.** Its glue keeps state outside linear memory (open-questions risk 1), and it isn't reachable from the agent sandbox, which can't reach npm.

## Why snapshot = linear memory

| State | Where it lives | Across a snapshot |
|---|---|---|
| QuickJS runtime, heap, objects, promises, job queue | linear memory | copied |
| libc state (malloc arenas, stdio) | linear memory | copied |
| shadow-stack pointer | the one mutable wasm global | equal to its initial value whenever no wasm call is active, so it's not saved |
| host functions | wasm table slots appended after the module's own | re-appended **in the same order** on every boot and restore, so stored function pointers still match. `restore` refuses a different order |
| JSRuntime/JSContext addresses | two integers | stored in the snapshot header |

**Rule for Prime:** snapshot only between host calls. Never from inside a host function, and never while an eval is running.

Host functions are wasm trampolines built at runtime: a hand-encoded ~200-byte module whose exported wasm functions call one JS import with their slot number. A plain JS function can't go into a wasm table. The interrupt handler (CPU limit) works the same way.

## Checks (all in `s1.test.ts`, each restore in a fresh `node` process via `child.ts`)

1. **Variables and functions survive.** `function greet`, a global `let counter` and a `var notes` array all read back correctly after restore.
2. **A pending promise resolves after restore.** Eval `e1` is suspended in `await fetch(...)` at snapshot time. In the child, `__pending.r1.resolve("world")` plus running jobs gives `__evals.e1 = {status: "done", value: "hello world 42"}`.
3. **Host functions work.** `__host_log` and `__host_fetch` fire after restore. The JS-side request counter continues from the snapshot: the next fetch is `r2`.
4. **Size and time** (Apple M4, Node 26):

   | | |
   |---|---|
   | linear memory | 2,424,832 bytes (37 pages) |
   | snapshot, gzip level 1 | ~120 KB |
   | snapshot (copy + gzip) | ~20–25 ms |
   | restore in a new process (compile wasm, gunzip, copy) | ~20–40 ms |

Also covered: restoring with host functions in a different order is refused; one snapshot restores into independent instances; the interrupt handler stops `for(;;){}` both before and after restore, and the instance is usable afterwards.

## Not done here

- **The same checks inside Lambda.** Needs a deployed function, so a person with AWS credentials has to run it. Expect the same behaviour: Node 22 in Lambda has the same `WebAssembly`.
- **The `/workspace` file system.** The shim has no files yet. #0012 adds fs host functions, which follow the same fixed-order rule.
- **Memory growth.** The snapshot is the whole linear memory. It's small now, but it grows with the REPL heap and never shrinks. Worth watching in #0015.
