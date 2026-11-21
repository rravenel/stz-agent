// Minimal checkpoint (spec §5.4), enough for a turn to span Prime runs.
// #0015 replaces the bodies (workspace sync, stale pending requests,
// crash tests); keep the two signatures.
//
// Write order: ckpt-<n>/state.json, ckpt-<n>/repl.bin, then latest.json, so a
// crash part-way leaves the previous checkpoint in effect.

import { checkpointReplKey, checkpointStateKey, LATEST_CHECKPOINT_KEY } from "../../shared/src/s3-keys.ts";
import { initialState, type LatestCheckpoint, type PrimeState } from "../../shared/src/state.ts";
import type { LogWriter } from "./log.ts";
import { Repl, type ReplOptions } from "./repl/repl.ts";
import { getJSON, type ObjectStore } from "./store.ts";

/** Log events written after a checkpoint by the same run: `checkpoint`, then `exit_idle`. */
const SEQS_RESERVED_AFTER_CHECKPOINT = 2;

export interface Loaded {
  state: PrimeState;
  repl: Repl;
  /** False on the very first run (no checkpoint yet). */
  restored: boolean;
}

export async function loadCheckpoint(store: ObjectStore, replOptions: ReplOptions): Promise<Loaded> {
  const latest = await getJSON<LatestCheckpoint>(store, LATEST_CHECKPOINT_KEY);
  if (!latest) return { state: initialState(), repl: await Repl.create(replOptions), restored: false };
  const state = await getJSON<PrimeState>(store, checkpointStateKey(latest.n));
  const snap = await store.get(checkpointReplKey(latest.n));
  if (!state || !snap) throw new Error(`checkpoint ${latest.n} is incomplete`);
  return { state, repl: await Repl.restore(snap, replOptions), restored: true };
}

/**
 * Write checkpoint n+1 and point latest.json at it. The saved next_seq skips
 * the seqs of the events this run logs after the checkpoint, so the next run
 * doesn't collide with them and misreport a crash (seq_conflict).
 */
export async function saveCheckpoint(store: ObjectStore, state: PrimeState, repl: Repl, log: LogWriter): Promise<number> {
  const n = state.n + 1;
  const snap = repl.snapshot();
  const saved: PrimeState = { ...state, n, next_seq: log.next + SEQS_RESERVED_AFTER_CHECKPOINT };
  await store.put(checkpointStateKey(n), JSON.stringify(saved));
  await store.put(checkpointReplKey(n), snap);
  await store.put(LATEST_CHECKPOINT_KEY, JSON.stringify({ n } satisfies LatestCheckpoint));
  state.n = n;
  await log.lifecycle("checkpoint", { n, repl_bytes: snap.length });
  return n;
}
