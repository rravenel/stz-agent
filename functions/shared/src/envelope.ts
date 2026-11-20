// The SQS message envelope shared by Doorman, Prime and Com (protocol §3).
// Bodies never travel through SQS: messages carry IDs and S3 keys only.

import { randomUUID } from "node:crypto";
import { isNonEmptyString, isRecord } from "./guards.ts";

export const ENVELOPE_VERSION = 1;

export type Endpoint = "doorman" | "prime" | "com";
export const ENDPOINTS: readonly Endpoint[] = ["doorman", "prime", "com"];

export type AuthMode = "none" | "anthropic" | "openai" | "bedrock" | "mock";
export const AUTH_MODES: readonly AuthMode[] = ["none", "anthropic", "openai", "bedrock", "mock"];

export type Purpose = "model" | "repl";

export interface UserMessageBody {
  text: string;
}

export interface HttpRequestBody {
  request_id: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body_ref?: string;
  auth: AuthMode;
  timeout_s: number;
  purpose: Purpose;
}

export interface HttpResponseBody {
  request_id: string;
  ok: boolean;
  status?: number;
  headers?: Record<string, string>;
  body_ref?: string;
  bytes?: number;
  elapsed_ms: number;
  error?: string;
}

export interface AckBody {
  acked_msg_id: string;
}

export interface BodyByType {
  "user.message": UserMessageBody;
  "http.request": HttpRequestBody;
  "http.response": HttpResponseBody;
  ack: AckBody;
}

export type MessageType = keyof BodyByType;
export const MESSAGE_TYPES: readonly MessageType[] = ["user.message", "http.request", "http.response", "ack"];

interface EnvelopeOf<T extends MessageType> {
  v: typeof ENVELOPE_VERSION;
  /** Unique per logical message. For user.message the client generates it. */
  msg_id: string;
  type: T;
  from: Endpoint;
  to: Endpoint;
  /** request_id for http.*, the acked msg_id for ack. */
  corr_id?: string;
  sent_at: string;
  body: BodyByType[T];
}

/** Discriminated union: narrowing on `type` narrows `body`. */
export type Envelope = { [T in MessageType]: EnvelopeOf<T> }[MessageType];
export type EnvelopeFor<T extends MessageType> = EnvelopeOf<T>;

export interface MakeOptions {
  msg_id?: string;
  corr_id?: string;
  now?: Date;
}

/** Build an envelope, filling v, msg_id and sent_at. */
export function makeEnvelope<T extends MessageType>(
  type: T,
  from: Endpoint,
  to: Endpoint,
  body: BodyByType[T],
  opts: MakeOptions = {},
): EnvelopeOf<T> {
  const env: EnvelopeOf<T> = {
    v: ENVELOPE_VERSION,
    msg_id: opts.msg_id ?? randomUUID(),
    type,
    from,
    to,
    sent_at: (opts.now ?? new Date()).toISOString(),
    body,
  };
  const corr = opts.corr_id ?? defaultCorrId(type, body);
  if (corr !== undefined) env.corr_id = corr;
  return env;
}

/** The ack a recipient sends back for `msg` (protocol §6). */
export function makeAck(msg: Envelope, opts: Omit<MakeOptions, "corr_id"> = {}): EnvelopeFor<"ack"> {
  return makeEnvelope("ack", msg.to, msg.from, { acked_msg_id: msg.msg_id }, { ...opts, corr_id: msg.msg_id });
}

function defaultCorrId(type: MessageType, body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const v = type === "http.request" || type === "http.response" ? body["request_id"] : type === "ack" ? body["acked_msg_id"] : undefined;
  return typeof v === "string" ? v : undefined;
}

export type ParseResult = { ok: true; value: Envelope } | { ok: false; error: string };

/** Validate an SQS message body (string or parsed JSON). Never throws. */
export function parseEnvelope(raw: unknown): ParseResult {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return { ok: false, error: "body is not JSON" };
    }
  }
  if (!isRecord(v)) return { ok: false, error: "envelope is not an object" };
  if (v["v"] !== ENVELOPE_VERSION) return { ok: false, error: `unsupported version ${String(v["v"])}` };
  if (!isNonEmptyString(v["msg_id"])) return { ok: false, error: "msg_id missing" };
  if (!MESSAGE_TYPES.includes(v["type"] as MessageType)) return { ok: false, error: `unknown type ${String(v["type"])}` };
  if (!ENDPOINTS.includes(v["from"] as Endpoint)) return { ok: false, error: "bad from" };
  if (!ENDPOINTS.includes(v["to"] as Endpoint)) return { ok: false, error: "bad to" };
  if (v["corr_id"] !== undefined && typeof v["corr_id"] !== "string") return { ok: false, error: "bad corr_id" };
  if (!isNonEmptyString(v["sent_at"]) || Number.isNaN(Date.parse(v["sent_at"]))) {
    return { ok: false, error: "bad sent_at" };
  }
  const err = bodyError(v["type"] as MessageType, v["body"]);
  if (err) return { ok: false, error: `${String(v["type"])} body: ${err}` };
  return { ok: true, value: v as unknown as Envelope };
}

function bodyError(type: MessageType, b: unknown): string | null {
  if (!isRecord(b)) return "not an object";
  const str = (k: string) => isNonEmptyString(b[k]);
  const optStr = (k: string) => b[k] === undefined || typeof b[k] === "string";
  const num = (k: string) => typeof b[k] === "number" && Number.isFinite(b[k]);
  const optNum = (k: string) => b[k] === undefined || num(k);
  const headers = (k: string, optional: boolean) =>
    (optional && b[k] === undefined) ||
    (isRecord(b[k]) && Object.values(b[k] as object).every((x) => typeof x === "string"));
  switch (type) {
    case "user.message":
      return typeof b["text"] === "string" ? null : "text must be a string";
    case "http.request":
      if (!str("request_id") || !str("method") || !str("url")) return "request_id, method and url are required";
      if (!headers("headers", false)) return "headers must map strings to strings";
      if (!optStr("body_ref")) return "bad body_ref";
      if (!AUTH_MODES.includes(b["auth"] as AuthMode)) return `bad auth ${String(b["auth"])}`;
      if (!num("timeout_s") || (b["timeout_s"] as number) <= 0) return "timeout_s must be a positive number";
      if (b["purpose"] !== "model" && b["purpose"] !== "repl") return "purpose must be model or repl";
      return null;
    case "http.response":
      if (!str("request_id")) return "request_id is required";
      if (typeof b["ok"] !== "boolean") return "ok must be a boolean";
      if (!num("elapsed_ms")) return "elapsed_ms is required";
      if (!optNum("status") || !optNum("bytes") || !optStr("body_ref") || !optStr("error")) return "bad optional field";
      if (!headers("headers", true)) return "headers must map strings to strings";
      return null;
    case "ack":
      return str("acked_msg_id") ? null : "acked_msg_id is required";
  }
}
