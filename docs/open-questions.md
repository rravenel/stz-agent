# Open questions and risks

When one is resolved, move the answer into spec.md or protocol.md and delete it here.

## Decided

- Functions in **TypeScript**, infra in Python CDK.
- **Browser tabled.**
- The REPL network proxy is a **host handler** behind `fetch()` that delegates to Com over SQS.
- Model providers: **Anthropic API, OpenAI Chat Completions spec (any compatible endpoint), Bedrock, and mock**. Prime has one adapter per provider; Com only does auth.
- **One agent and one log per stack.** `/clear` resets the conversation but keeps the REPL and the workspace.
- **Prime = 2 GB** as headroom.
- **No linger.** Prime always exits when idle.
- **If Com dies, its in-flight requests die.** No watchdog; Prime fails stale requests on restore.
- **One message queue per Lambda, no wake queues.** A wake is a **sync invoke** with a client-side abort. Only the ack is trusted, and the sender re-wakes every `WAKE_ACK_TIMEOUT` until the ack arrives (protocol §4–5).
- **Async invoke only for Prime's self-continuation** at 12 min.
- **SQS work runs in a comms worker thread** on Prime and Com, so acks never wait on the main thread.
- **Prime's state is persisted to S3 at each checkpoint.** Inbound messages are deleted only after a checkpoint, so the queue covers the gap between checkpoints.
- **Doorman: single-instance, with its own ack queue.** The client generates `msg_id` and retries POSTs on `503`.
- **Client pre-wakes Prime** with `POST /wake` when it opens, to pay the Lambda cold start up front. Prime exits right away, leaving a warm environment. No linger.
- **The demo client is sequential.** Concurrent clients are possible later.
- **Com accepts a request only if it fits in Com's remaining run time.**

## Risks: spike first (spec §10)

1. **S1: QuickJS WASM snapshot/restore.** Candidates: quickjs-emscripten (sync build, **not** Asyncify), or a QuickJS WASI build run under Node's `WebAssembly`/WASI with our own minimal fs. The Emscripten JS glue keeps some state outside linear memory, such as the stack pointer and FS. That's the likely snag, and the reason a WASI build may be easier. Fallback: replay the logged evals.
2. **S2: Lambda wake behaviour.** Settled by #0022 (2026-11-20/21, two stacks, four runs, all pass); results in `docs/protocol.md` §4.1.
   - A sync invoke to a busy reserved-concurrency-1 target returns 429 `TooManyRequestsException`, reason `ReservedFunctionConcurrentInvocationLimitExceeded`.
   - The target keeps running after the client aborts at 2 s (marker at 10.0 s).
   - The async self-wake starts 0.3–1.3 s after the parent finishes.
   - Stub cold invoke 1.6–1.7 s, warm 26–103 ms. On `StzAgent-brennan` the second run was warm; on `StzAgent-rene` both were cold, so warm reuse between wakes isn't reliable (see "How long do idle environments stay warm?").

## Still open

- **Separate reader Lambda for `GET /events`?** It's not needed while the client is sequential: one user, and no polling while a POST is outstanding. It becomes needed if we want concurrent clients, or a client that polls while posting. In that case a single-instance Doorman would throttle (429) polls during its ~20 s POST wait. The fix would be a tiny Lambda with unreserved concurrency, serving only `GET /events`: it reads S3, touches no queues, and needs nothing to be single-instance.
- **How long do idle environments stay warm?** It isn't specified. Measure the cold- vs. warm-start rate during the hackathon. If warm reuse is poor, a periodic keep-warm ping (an EventBridge schedule hitting the stale-wake path for about 100 ms) is cheap.
- **Cap on wake retries?** Today the delivery monitor loops forever.
- **Checkpoint after each turn**, as well as at exit? That narrows the window of crash loss, at the cost of more S3 writes.
- **Workspace storage.** Sync `/tmp/workspace` to S3 at checkpoint (the current plan), or use the S3 file system interface, if it works from Lambda?
- **Com default request timeout.** With a 10 min default, Com's accept window is only about 4 min per run.

## Parameters to tune

`ACK_TIMEOUT`, `WAKE_ACK_TIMEOUT` (per recipient, warm and cold), `WAKE_CALL_TIMEOUT`, `IDLE_GRACE`, the Prime continuation point (12 min), Com's deadline margin, the eval CPU limit, Com's per-request timeout, and the visibility timeouts.
