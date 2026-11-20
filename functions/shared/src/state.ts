// Prime's checkpointed state (spec §5.4) and the log event shape (spec §4.1).

export interface PendingRequest {
  purpose: "model" | "repl";
  /** The REPL eval or model tool call waiting on this request, if any. */
  tool_call_id?: string;
  sent_at: string;
  timeout_s: number;
}

/** Content of prime/ckpt-<n>/state.json. */
export interface PrimeState {
  n: number;
  /** Conversation number; increments on /clear. */
  conv: number;
  /** Messages for the current conversation, in the harness's internal turn format. */
  model_context: unknown[];
  /** In flight at Com, awaiting http.response. Keyed by request_id. */
  pending_requests: Record<string, PendingRequest>;
  /** Evals still pending in the REPL. */
  open_tool_calls: string[];
  /** Recent inbound msg_ids for dedupe; bounded (SEEN_MSG_IDS_LIMIT). */
  seen_msg_ids: string[];
  next_seq: number;
}

export const SEEN_MSG_IDS_LIMIT = 1000;

/** Content of prime/latest.json. */
export interface LatestCheckpoint {
  n: number;
}

export function initialState(): PrimeState {
  return { n: 0, conv: 0, model_context: [], pending_requests: {}, open_tool_calls: [], seen_msg_ids: [], next_seq: 0 };
}

/** Record a msg_id as seen, keeping only the most recent SEEN_MSG_IDS_LIMIT. Returns false if already seen. */
export function markSeen(state: PrimeState, msgId: string, limit = SEEN_MSG_IDS_LIMIT): boolean {
  if (state.seen_msg_ids.includes(msgId)) return false;
  state.seen_msg_ids.push(msgId);
  if (state.seen_msg_ids.length > limit) state.seen_msg_ids.splice(0, state.seen_msg_ids.length - limit);
  return true;
}

export type LogKind =
  | "user.message"
  | "conv.clear"
  | "model.request"
  | "model.response"
  | "tool.call"
  | "tool.result"
  | "http.request"
  | "http.response"
  | "lifecycle"
  | "error";

/** body.event values for kind "lifecycle"; they drive the demo narrative and the cost report. */
export type LifecycleEvent =
  | "start"
  | "restore"
  | "stale_wake"
  | "checkpoint"
  | "exit_idle"
  | "exit_deadline"
  | "wake_sent"
  | "seq_conflict";

/** One object at log/<seq>.json. Prime is the only writer. */
export interface LogEvent {
  seq: number;
  ts: string;
  /** Lambda request id of the Prime run that wrote it. */
  run: string;
  conv: number;
  kind: LogKind;
  /** request_id / tool_call_id; links request and response pairs. */
  corr_id?: string;
  /** Inbound msg_id, if any. */
  msg_id?: string;
  /** Small inline payload. */
  body?: unknown;
  /** Or a pointer to a large payload in bodies/. */
  body_ref?: string;
}
