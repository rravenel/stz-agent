// The Doorman HTTP API (#0007). Errors carry method, path and status only:
// the token never appears in an error or a log line.

import { randomUUID } from "node:crypto";

export interface LogEvent {
  seq: number;
  ts?: string;
  kind: string;
  msg_id?: string;
  corr_id?: string;
  body?: unknown;
  [k: string]: unknown;
}

export interface EventsPage {
  events: LogEvent[];
  next_after: number;
  more: boolean;
}

export class ApiError extends Error {
  readonly status: number | null;
  constructor(method: string, path: string, status: number | null, detail = "") {
    super(`${method} ${path} → ${status ?? "network error"}${detail ? ` (${detail})` : ""}`);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface ApiOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Backoff before attempts 2..6 of POST /messages. */
export const POST_BACKOFF_MS = [1000, 2000, 4000, 8000, 8000];

export class Api {
  private readonly base: string;
  private readonly token: string;
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(o: ApiOptions) {
    this.base = o.baseUrl.replace(/\/+$/, "");
    this.token = o.token;
    this.fetch = o.fetch ?? globalThis.fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async wake(): Promise<{ status: number; wake: unknown }> {
    const r = await this.request("POST", "/wake");
    if (!r.ok) throw new ApiError("POST", "/wake", r.status);
    const j = (await r.json()) as { wake?: unknown };
    return { status: r.status, wake: j.wake };
  }

  /** 503 and network errors are retried with the same msg_id; other errors throw at once. */
  async postMessage(text: string, msgId: string = randomUUID()): Promise<{ msg_id: string; attempts: number }> {
    let last: ApiError | null = null;
    for (let attempt = 1; attempt <= POST_BACKOFF_MS.length + 1; attempt++) {
      if (attempt > 1) await this.sleep(POST_BACKOFF_MS[attempt - 2]!);
      let r: Response;
      try {
        r = await this.request("POST", "/messages", { msg_id: msgId, text });
      } catch {
        last = new ApiError("POST", "/messages", null);
        continue;
      }
      if (r.status === 202) {
        await r.body?.cancel();
        return { msg_id: msgId, attempts: attempt };
      }
      await r.body?.cancel();
      last = new ApiError("POST", "/messages", r.status, r.status === 503 ? `after ${attempt} attempts` : "");
      if (r.status !== 503) throw last;
    }
    throw last!;
  }

  async events(after: number, limit = 200): Promise<EventsPage> {
    const path = `/events?after=${after}&limit=${limit}`;
    const r = await this.request("GET", path);
    if (!r.ok) throw new ApiError("GET", "/events", r.status);
    return (await r.json()) as EventsPage;
  }

  private request(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    return this.fetch(`${this.base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  }
}
