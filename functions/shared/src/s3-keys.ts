// S3 key layout for one stack's bucket (spec §4). Build keys only here.
//
//   log/<seq:010d>.json            append-only record, one object per event
//   bodies/<request_id>.req|.res   HTTP bodies (Prime writes .req, Com writes .res)
//   prime/ckpt-<n>/state.json      harness state
//   prime/ckpt-<n>/repl.bin        QuickJS WASM snapshot
//   prime/latest.json              {"n": N}, written last so a checkpoint is atomic
//   workspace/<path>               REPL file system, mirrored from /tmp/workspace

const SEQ_WIDTH = 10;
const ID_RE = /^[A-Za-z0-9._-]+$/;

function nonNegInt(n: number, what: string): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${what} must be a non-negative integer, got ${n}`);
  return n;
}

function safeId(id: string, what: string): string {
  // IDs end up in keys; refuse anything that could add a path segment.
  if (!ID_RE.test(id) || id === "." || id === "..") throw new RangeError(`unsafe ${what}: ${JSON.stringify(id)}`);
  return id;
}

export const LOG_PREFIX = "log/";

export function logKey(seq: number): string {
  const s = String(nonNegInt(seq, "seq"));
  if (s.length > SEQ_WIDTH) throw new RangeError(`seq ${seq} exceeds ${SEQ_WIDTH} digits`);
  return `${LOG_PREFIX}${s.padStart(SEQ_WIDTH, "0")}.json`;
}

/** Inverse of logKey; null for keys that aren't log events. */
export function seqFromLogKey(key: string): number | null {
  const m = /^log\/(\d{10})\.json$/.exec(key);
  return m ? Number(m[1]) : null;
}

export function requestBodyKey(requestId: string): string {
  return `bodies/${safeId(requestId, "request_id")}.req`;
}

export function responseBodyKey(requestId: string): string {
  return `bodies/${safeId(requestId, "request_id")}.res`;
}

export function checkpointStateKey(n: number): string {
  return `prime/ckpt-${nonNegInt(n, "checkpoint n")}/state.json`;
}

export function checkpointReplKey(n: number): string {
  return `prime/ckpt-${nonNegInt(n, "checkpoint n")}/repl.bin`;
}

export const LATEST_CHECKPOINT_KEY = "prime/latest.json";

export const WORKSPACE_PREFIX = "workspace/";

/** Key for a file under /workspace. Rejects absolute paths and `..`. */
export function workspaceKey(relPath: string): string {
  const parts = relPath.split("/");
  if (relPath === "" || relPath.startsWith("/") || parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new RangeError(`bad workspace path: ${JSON.stringify(relPath)}`);
  }
  return `${WORKSPACE_PREFIX}${relPath}`;
}
