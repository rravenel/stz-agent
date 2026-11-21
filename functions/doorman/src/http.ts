// API Gateway HTTP API (payload v2) parsing, responses and bearer auth. Pure.

import { timingSafeEqual } from "node:crypto";

export interface HttpEvent {
  rawPath?: string;
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string } };
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export interface Request {
  method: string;
  path: string;
  /** Header names lower-cased. */
  headers: Record<string, string>;
  query: Record<string, string>;
  body: string;
}

export function parseRequest(e: HttpEvent): Request {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(e.headers ?? {})) if (v !== undefined) headers[k.toLowerCase()] = v;
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(e.queryStringParameters ?? {})) if (v !== undefined) query[k] = v;
  const raw = e.body ?? "";
  return {
    method: (e.requestContext?.http?.method ?? "GET").toUpperCase(),
    path: e.rawPath ?? "/",
    headers,
    query,
    body: e.isBase64Encoded ? Buffer.from(raw, "base64").toString("utf8") : raw,
  };
}

export function json(statusCode: number, body: unknown): HttpResponse {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/** Constant-time check of `authorization: Bearer <token>`. */
export function authorized(req: Request, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(req.headers["authorization"] ?? "");
  if (!m || !token) return false;
  const a = Buffer.from(m[1]!, "utf8");
  const b = Buffer.from(token, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** JSON.parse that reports failure instead of throwing. */
export function parseJson(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}
