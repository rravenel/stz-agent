// Test helper: a real node:http server playing Doorman. Records requests and
// fails a test if a GET arrives while a POST is still being answered.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { EventsPage, LogEvent } from "./api.ts";

export interface Recorded {
  method: string;
  path: string;
  auth: string | undefined;
  body: unknown;
}

export class FakeDoorman {
  readonly requests: Recorded[] = [];
  readonly violations: string[] = [];
  /** Status codes for successive POST /messages; the last one repeats. */
  postStatuses: number[] = [202];
  postDelayMs = 0;
  /** Pages for successive GET /events; past the end, an empty page. */
  pages: EventsPage[] = [];
  /** Called on a 202 POST /messages, e.g. to queue pages that use its msg_id. */
  onPost: ((msgId: string) => void) | null = null;
  private posts = 0;
  private postInFlight = false;
  private server: Server | null = null;
  url = "";

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()));
  }

  gets(): Recorded[] {
    return this.requests.filter((r) => r.method === "GET");
  }

  private async handle(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const rec: Recorded = { method: req.method ?? "", path: req.url ?? "", auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null };
    this.requests.push(rec);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (rec.method === "GET" && this.postInFlight) this.violations.push(`GET ${rec.path} during a POST`);
    if (rec.method === "POST" && rec.path === "/wake") return json(202, { wake: { kind: "started" } });
    if (rec.method === "POST" && rec.path === "/messages") {
      this.postInFlight = true;
      if (this.postDelayMs) await new Promise((r) => setTimeout(r, this.postDelayMs));
      const status = this.postStatuses[Math.min(this.posts++, this.postStatuses.length - 1)]!;
      const msgId = (rec.body as { msg_id: string }).msg_id;
      if (status === 202) this.onPost?.(msgId);
      this.postInFlight = false;
      return json(status, status === 202 ? { msg_id: msgId } : { error: "x" });
    }
    if (rec.method === "GET" && rec.path.startsWith("/events")) {
      return json(200, this.pages.shift() ?? { events: [], next_after: Number(new URL(rec.path, "http://x").searchParams.get("after")), more: false });
    }
    json(404, {});
  }
}

export const ev = (seq: number, kind: string, extra: Partial<LogEvent> = {}): LogEvent => ({ seq, kind, ...extra });
