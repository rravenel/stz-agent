// Prime's agent loop (spec §5.1 step 5, §5.2, §5.3). It is event-driven and
// never waits on the network: a model call or a REPL fetch is sent to Com and
// the loop moves on. Its whole state is `PrimeState` (model context, pending
// requests, open tool calls) plus the REPL, so a turn can stop at any point
// where it is waiting and resume in a later Prime run from a checkpoint.
//
// Work is runnable when the context ends with a user message (new text or tool
// results), no model call is in flight, and no tool call is still open.

import type { EnvelopeFor } from "../../shared/src/envelope.ts";
import type { PrimeState } from "../../shared/src/state.ts";
import type { LogWriter } from "./log.ts";
import type { Block, Message, ModelAdapter, ModelReply, ToolCallBlock } from "./models/turn.ts";
import { REPL_TOOL, ModelResponseError } from "./models/turn.ts";
import type { InboundResponse, Proxy } from "./proxy.ts";
import type { EvalResult, FetchRequest, Repl } from "./repl/repl.ts";
import { requestBodyKey } from "../../shared/src/s3-keys.ts";

export const DEFAULT_MAX_TOKENS = 4096;
/** Longest tool result handed back to the model; the rest is cut with a marker. */
export const TOOL_RESULT_LIMIT = 16 * 1024;
export const CLEAR_COMMAND = "/clear";

export const DEFAULT_SYSTEM =
  "You are an agent with one tool, `repl`, a persistent JavaScript REPL. Use it for HTTP (fetch), files " +
  "(/workspace via the fs global) and computation. Each call runs as an async function body: `return` a value, " +
  "and keep anything you need in later calls on globalThis. Requests may take minutes; just await them.";

/**
 * Request ids. A model call takes the seq its model.request event was written
 * at (seqs never repeat). A REPL fetch is `repl-<run>-<rN>`: rN is the REPL's
 * own counter, which restarts from the checkpoint after a crash, so the run
 * prefix keeps a re-issued fetch from sharing an id with the crashed run's
 * request. Com then runs it again (spec §5.4 allows duplicates), and the
 * crashed run's late response is unknown and dropped (#0013 review, note 3).
 */
export const modelRequestId = (seq: number) => `model-${seq}`;
export const replRequestId = (runTag: string, replId: string) => `repl-${runTag}-${replId}`;
/** The REPL's own id (rN) inside a REPL request id. */
export function replIdOf(requestId: string): string | null {
  const m = /^repl-[A-Za-z0-9]+-(r\d+)$/.exec(requestId);
  return m ? m[1]! : null;
}
/** A short, key-safe tag for a run id. */
export const runTag = (run: string) => (run.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "run");

export interface HarnessOptions {
  state: PrimeState;
  repl: Repl;
  /** Where the REPL's onFetch callback queues requests (it may not call back into the REPL). */
  outbox: FetchRequest[];
  adapter: ModelAdapter;
  proxy: Proxy;
  log: LogWriter;
  system?: string;
  maxTokens?: number;
  /** Lambda request id of this run; tags REPL request ids. */
  run: string;
}

/**
 * Make a context valid for a provider: merge consecutive same-role messages,
 * put tool results first in a user message (a user message that arrived
 * mid-turn lands after them), and drop empty text blocks and empty messages.
 */
export function normalize(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    const blocks = m.content.filter((b) => b.type !== "text" || b.text.trim() !== "");
    if (blocks.length === 0) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content.push(...blocks);
    else out.push({ role: m.role, content: [...blocks] });
  }
  for (const m of out) {
    if (m.role !== "user") continue;
    m.content = [...m.content.filter((b) => b.type === "tool_result"), ...m.content.filter((b) => b.type !== "tool_result")];
  }
  return out;
}

export function toolResultContent(r: Extract<EvalResult, { status: "done" }>): string {
  const s = JSON.stringify({ value: r.value, stdout: r.stdout, stderr: r.stderr, error: r.error });
  return s.length <= TOOL_RESULT_LIMIT ? s : `${s.slice(0, TOOL_RESULT_LIMIT)}… [truncated ${s.length - TOOL_RESULT_LIMIT} chars]`;
}

export class Harness {
  private readonly o: HarnessOptions;

  constructor(o: HarnessOptions) {
    this.o = o;
  }

  private get state() {
    return this.o.state;
  }

  private get context(): Message[] {
    return this.state.model_context as Message[];
  }

  /** A model call is in flight. */
  modelPending(): boolean {
    return Object.values(this.state.pending_requests).some((p) => p.purpose === "model");
  }

  /** There is a turn to advance now (spec §5.5 step 1 is the negation). */
  runnable(): boolean {
    if (this.modelPending() || this.state.open_tool_calls.length > 0) return false;
    const ctx = normalize(this.context);
    return ctx.length > 0 && ctx[ctx.length - 1]!.role === "user";
  }

  // ------------------------------------------------------------ inbound

  async onUserMessage(msg: EnvelopeFor<"user.message">): Promise<void> {
    const { log } = this.o;
    await log.append("user.message", { msg_id: msg.msg_id, body: { text: msg.body.text } });
    if (msg.body.text.trim() === CLEAR_COMMAND) {
      await this.clear(msg.msg_id);
      return;
    }
    this.context.push({ role: "user", content: [{ type: "text", text: msg.body.text }] });
  }

  /** /clear: new conversation. The REPL and the workspace carry over (spec §4). */
  private async clear(msgId: string): Promise<void> {
    const { state, log } = this.o;
    state.conv++;
    log.conv = state.conv;
    state.model_context = [];
    // A late response to the old conversation's model call is then unknown and dropped.
    for (const [id, p] of Object.entries(state.pending_requests)) if (p.purpose === "model") delete state.pending_requests[id];
    // Their evals may still be waiting on fetches: drop them in the REPL too,
    // or their results would sit in every later snapshot (#0013 review, note 1).
    for (const id of state.open_tool_calls) this.o.repl.discard(id);
    state.open_tool_calls = [];
    await log.append("conv.clear", { msg_id: msgId, body: { conv: state.conv } });
  }

  async onHttpResponse(msg: EnvelopeFor<"http.response">): Promise<void> {
    const res = await this.o.proxy.receive(msg);
    if (!res) return;
    if (res.purpose === "model") await this.onModelResponse(res);
    else await this.onReplResponse(res);
  }

  private async onReplResponse(res: InboundResponse): Promise<void> {
    const { repl } = this.o;
    const id = replIdOf(res.requestId);
    if (!id) return;
    if (res.ok) repl.resolvePending(id, { status: res.status ?? 200, headers: res.headers, body: res.body });
    else repl.rejectPending(id, res.error ?? "request failed");
    await this.flushFetches();
    await this.collectSettled();
  }

  private async onModelResponse(res: InboundResponse): Promise<void> {
    const { adapter, log } = this.o;
    let reply: ModelReply;
    try {
      if (!res.ok) throw new ModelResponseError(`${res.error ?? "request failed"}${res.status ? ` (HTTP ${res.status})` : ""}`);
      reply = adapter.fromResponse(res.body);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await log.append("error", { corr_id: res.requestId, body: { where: "model.response", message } });
      // End the turn visibly. Without an assistant message the context would
      // still end with the user's turn and be retried forever.
      this.context.push({ role: "assistant", content: [{ type: "text", text: `[harness: the model call failed: ${message}]` }] });
      return;
    }
    await log.append("model.response", {
      corr_id: res.requestId,
      body: { stop: reply.stop, usage: reply.usage, content: reply.content },
    });
    this.context.push({ role: "assistant", content: reply.content });
    for (const call of reply.content) if (call.type === "tool_call") await this.runTool(call);
    await this.flushFetches();
  }

  /**
   * After a restore: fail every pending request older than timeout_s + 60 s
   * as lost (spec §5.4). Com died and took it along. The REPL promise is
   * rejected, or the model call reported failed, and the turn carries on.
   */
  async failStale(now: Date): Promise<string[]> {
    const { state, log } = this.o;
    const lost: string[] = [];
    for (const [id, p] of Object.entries(state.pending_requests)) {
      const limitS = p.timeout_s + 60;
      if (now.getTime() - Date.parse(p.sent_at) <= limitS * 1000) continue;
      delete state.pending_requests[id];
      lost.push(id);
      const error = `lost: no response within ${limitS} s`;
      await log.append("error", { corr_id: id, body: { where: "pending_request", lost: true, purpose: p.purpose, sent_at: p.sent_at, message: error } });
      const res: InboundResponse = { requestId: id, purpose: p.purpose, ok: false, headers: {}, body: "", error };
      if (p.purpose === "model") await this.onModelResponse(res);
      else await this.onReplResponse(res);
    }
    return lost;
  }

  // ------------------------------------------------------------ tools

  private async runTool(call: ToolCallBlock): Promise<void> {
    const { log, repl } = this.o;
    await log.append("tool.call", { corr_id: call.id, body: { name: call.name, input: call.input } });
    const code = call.input["code"];
    if (call.name !== REPL_TOOL.name) return this.toolResult(call.id, `unknown tool ${JSON.stringify(call.name)}; the only tool is repl`, true);
    // #0014 review: an adapter keeps unparseable arguments as text. Never run that as code.
    if (call.input["_invalid_json"] === true) {
      return this.toolResult(call.id, `arguments were not valid JSON: ${String(code).slice(0, 500)}`, true);
    }
    if (typeof code !== "string") return this.toolResult(call.id, "the repl tool needs a string `code` argument", true);
    const r = repl.eval(call.id, code);
    this.attributeFetches(call.id);
    if (r.status === "pending") {
      this.state.open_tool_calls.push(call.id);
      return;
    }
    await this.toolResult(call.id, toolResultContent(r), r.error !== undefined);
  }

  private async toolResult(id: string, content: string, isError: boolean): Promise<void> {
    await this.o.log.append("tool.result", { corr_id: id, body: { content, is_error: isError } });
    const block: Block = { type: "tool_result", tool_call_id: id, content, ...(isError ? { is_error: true } : {}) };
    this.context.push({ role: "user", content: [block] });
  }

  /** Tool calls whose evals settled after a fetch response. */
  private async collectSettled(): Promise<void> {
    const { repl, state } = this.o;
    for (const id of [...state.open_tool_calls]) {
      const r = repl.take(id);
      if (r.status === "pending") continue;
      state.open_tool_calls = state.open_tool_calls.filter((x) => x !== id);
      await this.toolResult(id, toolResultContent(r), r.error !== undefined);
    }
  }

  private readonly fetchOwner = new Map<string, string>();

  private attributeFetches(toolCallId: string) {
    for (const f of this.o.outbox) if (!this.fetchOwner.has(f.requestId)) this.fetchOwner.set(f.requestId, toolCallId);
  }

  /** Send the REPL's queued fetches (it can't do async work from inside an eval). */
  private async flushFetches(): Promise<void> {
    const { outbox, proxy, state } = this.o;
    while (outbox.length) {
      const f = outbox.shift()!;
      // Fetches made by code resumed after a response belong to the only open tool call, if there is one.
      const owner = this.fetchOwner.get(f.requestId) ?? (state.open_tool_calls.length === 1 ? state.open_tool_calls[0] : undefined);
      this.fetchOwner.delete(f.requestId);
      await proxy.send(replRequestId(runTag(this.o.run), f.requestId), "repl", { method: f.method, url: f.url, headers: f.headers, body: f.body, auth: "none" }, owner);
    }
  }

  // ------------------------------------------------------------ model

  /** Advance the turn if it is runnable: one model call, sent without waiting. Returns whether it called. */
  async step(): Promise<boolean> {
    await this.flushFetches();
    if (!this.runnable()) return false;
    const { adapter, log, proxy } = this.o;
    const messages = normalize(this.context);
    this.state.model_context = messages;
    const req = adapter.toRequest({ system: this.o.system ?? DEFAULT_SYSTEM, messages, max_tokens: this.o.maxTokens ?? DEFAULT_MAX_TOKENS });
    const ev = await log.append("model.request", (seq) => ({
      corr_id: modelRequestId(seq),
      body: { provider: adapter.provider, messages: messages.length },
      body_ref: requestBodyKey(modelRequestId(seq)),
    }));
    const requestId = ev.corr_id!;
    await proxy.send(requestId, "model", { method: req.method, url: req.url, headers: req.headers, body: req.body, auth: req.auth });
    return true;
  }
}
