# Open questions and risks

When one is resolved, move the answer into spec.md or protocol.md and delete it here.

## Decided

- Functions in **TypeScript**, infra in Python CDK.
- The REPL network proxy is a **host handler** behind `fetch()` that delegates to Com over SQS. It is not a literal HTTP proxy.
- **Browser tabled.**
- Model providers: **Anthropic API, OpenAI Chat Completions spec (any compatible endpoint), Bedrock, and mock**. Prime has one adapter per provider; Com only does auth.
- **No linger.** Prime always exits when idle, because v0 has no way to predict wait length. Heuristics from logged request durations are future work.
- **If Com dies, its in-flight requests die.** No watchdog. Prime fails stale pending requests on its next wake.
- **Prime = 2 GB** as headroom.
- **One agent and one log per stack.** `/clear` resets the conversation but keeps the REPL and the workspace.
- **Wake = async Lambda invoke with a 60 s max event age**, not an SQS trigger, so wakes can't accumulate (protocol §2). This means Doorman no longer needs to be a singleton.

## Risks: spike first

1. **QuickJS WASM snapshot/restore** (spec §5.2). Prove these, in this order:
   1. Dumping memory, globals, and table, then loading them into a fresh instance in a new process, restores variables and functions.
   2. A promise left pending in `__pending` can be resolved after restore, and the awaiting async function continues.
   3. Host functions re-registered in the same order still work after restore.
   4. Snapshot size and restore time are acceptable (target < 1 s).

   Candidates: quickjs-emscripten (sync build, **not** Asyncify), or a QuickJS WASI build run under Node's `WebAssembly`/WASI with our own minimal fs. The Emscripten JS glue holds some state outside linear memory, such as the stack pointer and FS. That is the likely snag, and the reason a WASI build may be easier.

   Fallback: replay logged evals (spec §10).
2. **Async-invoke throttle retry timing** with reserved concurrency 1. Does the wake land within seconds of the previous instance exiting? (protocol §2)

## Still open

- **Workspace storage.** Sync `/tmp/workspace` to S3 at checkpoint (the current plan), or use the S3 file system interface, if it works from Lambda? With a 4-hour budget, sync it is, unless someone already knows the other path works.

## Parameters to tune

`ACK_TIMEOUT`, `WAKE_TIMEOUT`, `WAKE_RETRIES`, `MaximumEventAgeInSeconds`, `IDLE_GRACE`, deadline margin, eval CPU limit, Com per-request timeout, inbox visibility timeout.
