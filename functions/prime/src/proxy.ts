// Prime's network proxy (spec §5.3): every outbound HTTP call (model calls and
// REPL fetches) goes to Com as an http.request, without waiting. The request
// body goes to S3 first, the request is recorded in state.pending_requests and
// logged, and only then sent. Responses come back as http.response messages,
// possibly in a later Prime run.

import type { Comms } from "../../shared/src/comms.ts";
import type { AuthMode, EnvelopeFor, Purpose } from "../../shared/src/envelope.ts";
import { requestBodyKey } from "../../shared/src/s3-keys.ts";
import type { PrimeState } from "../../shared/src/state.ts";
import type { LogWriter } from "./log.ts";
import { getText, type ObjectStore } from "./store.ts";

export const DEFAULT_TIMEOUT_S = 600;

export interface OutboundRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  auth: AuthMode;
}

export interface InboundResponse {
  requestId: string;
  purpose: Purpose;
  toolCallId?: string;
  ok: boolean;
  status?: number;
  headers: Record<string, string>;
  /** The response body as text ("" when there is none). */
  body: string;
  error?: string;
}

export class Proxy {
  private readonly store: ObjectStore;
  private readonly comms: Comms;
  private readonly log: LogWriter;
  private readonly state: PrimeState;
  private readonly now: () => Date;

  constructor(store: ObjectStore, comms: Comms, log: LogWriter, state: PrimeState, now: () => Date = () => new Date()) {
    this.store = store;
    this.comms = comms;
    this.log = log;
    this.state = state;
    this.now = now;
  }

  /** Body to S3, record as pending, log, send. Returns once it is enqueued for Com; never waits for the response. */
  async send(requestId: string, purpose: Purpose, req: OutboundRequest, toolCallId?: string): Promise<void> {
    const timeout_s = DEFAULT_TIMEOUT_S;
    let body_ref: string | undefined;
    if (req.body !== null) {
      body_ref = requestBodyKey(requestId);
      await this.store.put(body_ref, req.body);
    }
    this.state.pending_requests[requestId] = {
      purpose,
      ...(toolCallId ? { tool_call_id: toolCallId } : {}),
      sent_at: this.now().toISOString(),
      timeout_s,
    };
    await this.log.append("http.request", {
      corr_id: requestId,
      body: { purpose, method: req.method, url: req.url, auth: req.auth },
      ...(body_ref ? { body_ref } : {}),
    });
    this.comms.send("com", "http.request", {
      request_id: requestId,
      method: req.method,
      url: req.url,
      headers: req.headers,
      ...(body_ref ? { body_ref } : {}),
      auth: req.auth,
      timeout_s,
      purpose,
    });
  }

  /**
   * Match an http.response to its pending request: remove it from
   * pending_requests, log it, and read the body from S3. Returns null (after
   * logging) for a request_id that isn't pending (a duplicate, a request
   * dropped by /clear, or one lost in a crash).
   */
  async receive(msg: EnvelopeFor<"http.response">): Promise<InboundResponse | null> {
    const r = msg.body;
    const pending = this.state.pending_requests[r.request_id];
    if (!pending) {
      await this.log.append("http.response", {
        corr_id: r.request_id,
        msg_id: msg.msg_id,
        body: { dropped: "unknown request_id", ok: r.ok, status: r.status },
      });
      return null;
    }
    delete this.state.pending_requests[r.request_id];
    await this.log.append("http.response", {
      corr_id: r.request_id,
      msg_id: msg.msg_id,
      body: { purpose: pending.purpose, ok: r.ok, status: r.status, elapsed_ms: r.elapsed_ms, ...(r.error ? { error: r.error } : {}) },
      ...(r.body_ref ? { body_ref: r.body_ref } : {}),
    });
    let body = "";
    let error = r.error;
    if (r.body_ref) {
      const text = await getText(this.store, r.body_ref);
      if (text === null && r.ok) error = `response body missing at ${r.body_ref}`;
      body = text ?? "";
    }
    const ok = r.ok && error === undefined;
    return {
      requestId: r.request_id,
      purpose: pending.purpose,
      ...(pending.tool_call_id ? { toolCallId: pending.tool_call_id } : {}),
      ok,
      ...(r.status !== undefined ? { status: r.status } : {}),
      headers: r.headers ?? {},
      body,
      ...(ok ? {} : { error: error ?? "request failed" }),
    };
  }
}
