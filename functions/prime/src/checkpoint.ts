// Checkpoint and restore (spec §5.4).
//
// Write order: ckpt-<n>/state.json, ckpt-<n>/repl.bin, the workspace sync,
// then latest.json. latest.json is the commit point: a failure anywhere
// before it throws, and the previous checkpoint's state and REPL stay in
// effect. Held SQS messages are deleted only after this returns (handler.ts).
//
// The workspace is NOT versioned per checkpoint: workspace/ is one shared
// prefix, as spec §5.4 lays it out. A crash after the sync but before
// latest.json restores the previous state and REPL alongside the newer
// workspace (files written or deleted by the lost run). Redone evals mostly
// rewrite the same files, which is acceptable for v0 (decision in #0016);
// versioning workspace keys per checkpoint is the fix if it ever matters.

import { checkpointReplKey, checkpointStateKey, LATEST_CHECKPOINT_KEY } from "../../shared/src/s3-keys.ts";
import { initialState, type LatestCheckpoint, type PrimeState } from "../../shared/src/state.ts";
import type { LogWriter } from "./log.ts";
import { Repl, type ReplOptions } from "./repl/repl.ts";
import { DEFAULT_WORKSPACE_DIR } from "./repl/workspace.ts";
import { getJSON, type ObjectStore } from "./store.ts";
import { syncDown, syncUp, type Manifest } from "./workspace-sync.ts";

/** Log events written after a checkpoint by the same run: `checkpoint`, then `exit_idle`. */
const SEQS_RESERVED_AFTER_CHECKPOINT = 2;

export interface WorkspaceMirror {
  dir: string;
  /** What S3 workspace/ holds, by path → SHA-256. */
  manifest: Manifest;
}

export interface Loaded {
  state: PrimeState;
  repl: Repl;
  workspace: WorkspaceMirror;
  /** False on the very first run (no checkpoint yet). */
  restored: boolean;
  /** workspace/ keys the restore skipped, with why. */
  workspaceSkipped: { key: string; reason: string }[];
}

/** Just the saved state (no REPL, no workspace): enough for a stale wake to log at the right seq. */
export async function peekState(store: ObjectStore): Promise<PrimeState> {
  const latest = await getJSON<LatestCheckpoint>(store, LATEST_CHECKPOINT_KEY);
  if (!latest) return initialState();
  return (await getJSON<PrimeState>(store, checkpointStateKey(latest.n))) ?? initialState();
}

export async function loadCheckpoint(store: ObjectStore, replOptions: ReplOptions): Promise<Loaded> {
  const dir = replOptions.workspaceDir ?? DEFAULT_WORKSPACE_DIR;
  const latest = await getJSON<LatestCheckpoint>(store, LATEST_CHECKPOINT_KEY);
  let state = initialState();
  let snap: Uint8Array | null = null;
  if (latest) {
    const s = await getJSON<PrimeState>(store, checkpointStateKey(latest.n));
    snap = await store.get(checkpointReplKey(latest.n));
    if (!s || !snap) throw new Error(`checkpoint ${latest.n} is incomplete`);
    state = s;
  }
  // The workspace first: the REPL's fs binds to the directory as it is.
  const { manifest, skipped } = await syncDown(store, dir);
  const repl = snap ? await Repl.restore(snap, replOptions) : await Repl.create(replOptions);
  return { state, repl, workspace: { dir, manifest }, restored: latest !== null, workspaceSkipped: skipped };
}

export interface SaveResult {
  n: number;
  uploaded: number;
  deleted: number;
  skipped: string[];
}

/**
 * Write checkpoint n+1 and point latest.json at it. The saved next_seq skips
 * the seqs of the events this run logs after the checkpoint, so the next run
 * doesn't collide with them and misreport a crash (seq_conflict).
 */
export async function saveCheckpoint(
  store: ObjectStore,
  state: PrimeState,
  repl: Repl,
  log: LogWriter,
  workspace: WorkspaceMirror,
): Promise<SaveResult> {
  const n = state.n + 1;
  const snap = repl.snapshot();
  const saved: PrimeState = { ...state, n, next_seq: log.next + SEQS_RESERVED_AFTER_CHECKPOINT };
  await store.put(checkpointStateKey(n), JSON.stringify(saved));
  await store.put(checkpointReplKey(n), snap);
  const ws = await syncUp(store, workspace.dir, workspace.manifest);
  await store.put(LATEST_CHECKPOINT_KEY, JSON.stringify({ n } satisfies LatestCheckpoint));
  state.n = n;
  await log.lifecycle("checkpoint", {
    n,
    repl_bytes: snap.length,
    workspace: { uploaded: ws.uploaded.length, deleted: ws.deleted.length, ...(ws.skipped.length ? { skipped: ws.skipped } : {}) },
  });
  return { n, uploaded: ws.uploaded.length, deleted: ws.deleted.length, skipped: ws.skipped };
}
