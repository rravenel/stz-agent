// Com's main thread (spec §6, protocol §6, §7.2): accept http.requests from
// Prime, run them (real fetch or mock://), stream each body to S3 and send
// exactly one terminal http.response. Everything external is injected.

import type { Comms, Delivery } from "../../shared/src/comms.ts";
import type { EnvelopeFor, HttpRequestBody, HttpResponseBody } from "../../shared/src/envelope.ts";
import { responseBodyKey } from "../../shared/src/s3-keys.ts";
import { applyAuth, type SecretSource } from "./auth.ts";
import { MOCK_SCRIPT_KEY, mockRespond, type MockStep } from "./mock.ts";

export interface ComStore {
  getText(key: string): Promise<string | null>;
  /** Stream to S3 without buffering the whole body. */
  putStream(key: string, body: ReadableStream<Uint8Array>, contentType?: string): Promise<void>;
  getJSONOrNull<T>(key: string): Promise<T | null>;
}

export interface ComDeps {
  comms: Comms;
  store: ComStore;
  secrets: SecretSource;
  fetch: typeof fetch;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
  log(e: Record<string, unknown>): void;
  /** Epoch ms when this Lambda run is killed. */
  runEndsAtMs: number;
  delayScale?: number;
  checkEveryMs?: number;
  finalPollMs?: number;
  /** Abort in-flight work and exit when less than this much run time is left. */
  exitMarginMs?: number;
}

const KEPT_HEADERS = ["content-type", "request-id", "x-request-id"];

export class ComCore {
  private readonly d: ComDeps;
  private readonly seen = new Set<string>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly runAbort = new AbortController();
  handled = 0;

  constructor(deps: ComDeps) {
    this.d = deps;
    deps.comms.onMessage((m) => this.accept(m));
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /** Until idle (protocol §7.2) or the run deadline. */
  async run(): Promise<"idle" | "deadline"> {
    const every = this.d.checkEveryMs ?? 250;
    for (;;) {
      if (this.d.runEndsAtMs - this.d.now() < (this.d.exitMarginMs ?? 10_000)) {
        this.runAbort.abort(new Error("run deadline"));
        this.d.log({ kind: "exit_deadline", in_flight: this.inFlight.size });
        return "deadline";
      }
      if (this.inFlight.size === 0 && this.d.comms.unackedCount() === 0) {
        const empty = await this.d.comms.finalPoll(this.d.finalPollMs ?? 2000);
        if (empty && this.inFlight.size === 0 && this.d.comms.unackedCount() === 0) return "idle";
        continue;
      }
      await new Promise((r) => setTimeout(r, every));
    }
  }

  private accept({ msg, receipt }: Delivery): void {
    if (msg.type !== "http.request") {
      this.d.log({ kind: "unexpected", type: msg.type, msg_id: msg.msg_id });
      void this.d.comms.deleteMessage(receipt).catch(() => {});
      return;
    }
    const id = msg.body.request_id;
    void this.d.comms.deleteMessage(receipt).catch((e: unknown) => this.d.log({ kind: "delete-failed", error: String(e) }));
    if (this.seen.has(id)) {
      this.d.log({ kind: "duplicate", request_id: id });
      return;
    }
    this.seen.add(id);
    const p = this.process(msg).finally(() => this.inFlight.delete(p));
    this.inFlight.add(p);
  }

  private async process(msg: EnvelopeFor<"http.request">): Promise<void> {
    const req = msg.body;
    const start = this.d.now();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error("timeout")), req.timeout_s * 1000);
    const signal = AbortSignal.any([timeout.signal, this.runAbort.signal]);
    let out: Omit<HttpResponseBody, "request_id" | "elapsed_ms">;
    try {
      out = await this.execute(req, signal);
    } catch (e) {
      const error = timeout.signal.aborted
        ? `timeout after ${req.timeout_s}s`
        : this.runAbort.signal.aborted
          ? "aborted: com run deadline"
          : e instanceof Error
            ? e.message
            : String(e);
      out = { ok: false, error };
    } finally {
      clearTimeout(timer);
    }
    this.handled++;
    const body: HttpResponseBody = { request_id: req.request_id, ...out, elapsed_ms: this.d.now() - start };
    this.d.log({ kind: "response", request_id: req.request_id, ok: body.ok, status: body.status, bytes: body.bytes, error: body.error });
    this.d.comms.send("prime", "http.response", body, { corr_id: req.request_id });
  }

  private async execute(req: HttpRequestBody, signal: AbortSignal): Promise<Omit<HttpResponseBody, "request_id" | "elapsed_ms">> {
    const reqBody = req.body_ref ? await this.d.store.getText(req.body_ref) : null;
    if (req.body_ref && reqBody === null) throw new Error(`request body ${req.body_ref} not found`);
    let res: Response;
    if (req.url.startsWith("mock://")) {
      res = await mockRespond(
        req.url,
        reqBody,
        {
          sleep: this.d.sleep,
          delayScale: this.d.delayScale ?? 1,
          loadScript: () => this.d.store.getJSONOrNull<MockStep[]>(MOCK_SCRIPT_KEY),
        },
        signal,
      );
    } else {
      const headers = await applyAuth(req, this.d.secrets, reqBody);
      res = await this.d.fetch(req.url, { method: req.method, headers, ...(reqBody !== null ? { body: reqBody } : {}), signal });
    }
    const headers: Record<string, string> = {};
    for (const h of KEPT_HEADERS) {
      const v = res.headers.get(h);
      if (v !== null) headers[h] = v;
    }
    const key = responseBodyKey(req.request_id);
    let bytes = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        bytes += chunk.byteLength;
        ctl.enqueue(chunk);
      },
    });
    const source = res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
    await this.d.store.putStream(key, source.pipeThrough(counter, { signal }), headers["content-type"]);
    return { ok: res.ok, status: res.status, headers, body_ref: key, bytes };
  }
}
