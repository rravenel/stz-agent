// Test helper (not a test file): a fake stack for driving Prime run by run.
// Each run() is a fresh handler invocation that restores from the store, as a
// new Lambda would. The test plays the client and Com.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryBus, type Comms, type InMemoryComms } from "../../shared/src/comms.ts";
import type { EnvelopeFor } from "../../shared/src/envelope.ts";
import { responseBodyKey } from "../../shared/src/s3-keys.ts";
import type { LogEvent, PrimeState } from "../../shared/src/state.ts";
import { createHandler } from "./handler.ts";
import { anthropicAdapter } from "./models/anthropic.ts";
import { MOCK_URL } from "./models/config.ts";
import { getJSON, getText, MemoryStore, type ObjectStore } from "./store.ts";

export const adapter = anthropicAdapter({ model: "mock", url: MOCK_URL, auth: "mock" });

export const anthropic = (content: unknown[], stop = "end_turn") =>
  JSON.stringify({ type: "message", role: "assistant", content, stop_reason: stop });
export const toolUse = (id: string, code: string) => anthropic([{ type: "tool_use", id, name: "repl", input: { code } }], "tool_use");
export const kinds = (events: LogEvent[]) =>
  events.map((e) => (e.kind === "lifecycle" ? `lifecycle:${(e.body as { event: string }).event}` : e.kind));

export interface WorldOptions {
  /** Wrap the store Prime uses (fault injection, recording). The test's own view stays the raw store. */
  wrapStore?: (s: MemoryStore) => ObjectStore;
  /** Wrap each run's comms (recording deletes). */
  wrapComms?: (c: Comms) => Comms;
  now?: () => Date;
  /** A live Com acks Prime's requests during runs (default). Off: nothing acks until the test acts as Com. */
  comAcks?: boolean;
  /** Extra handler deps (deadlines, selfWake …). */
  deps?: Partial<import("./handler.ts").PrimeDeps>;
}

export class World {
  readonly bus = new InMemoryBus();
  readonly store = new MemoryStore();
  readonly workspaceDir = join(mkdtempSync(join(tmpdir(), "stz-prime-")), "workspace");
  private readonly client = this.bus.connect("doorman");
  private runs = 0;
  readonly handler;
  private readonly comAcks: boolean;

  constructor(opts: WorldOptions = {}) {
    this.client.onMessage(() => {}); // acks from Prime
    this.comAcks = opts.comAcks ?? true;
    this.startAcker();
    this.handler = createHandler({
      comms: () => {
        const c = this.bus.connect("prime");
        return opts.wrapComms ? opts.wrapComms(c) : c;
      },
      store: opts.wrapStore ? opts.wrapStore(this.store) : this.store,
      adapter,
      replOptions: { workspaceDir: this.workspaceDir },
      idleGraceMs: 5,
      staleWakeMs: 50,
      ackPollMs: 2,
      ...(opts.now ? { now: opts.now } : {}),
      ...opts.deps,
    });
  }

  /** A passive Com: its worker acks every http.request but leaves it queued for takeRequests(). */
  startAcker() {
    if (!this.comAcks) return;
    this.bus.connect("com").onMessage(() => {});
  }

  say(text: string, msgId: string) {
    this.client.send("prime", "user.message", { text }, { msg_id: msgId });
  }

  run(reason = "wake") {
    return this.handler({ reason }, { awsRequestId: `run${++this.runs}` });
  }

  /** Com: take every http.request waiting in its queue (accept = delete), as Com would. */
  async takeRequests(): Promise<EnvelopeFor<"http.request">[]> {
    const com: InMemoryComms = this.bus.connect("com");
    const got: EnvelopeFor<"http.request">[] = [];
    com.onMessage((d) => {
      if (d.msg.type === "http.request") got.push(d.msg);
      void com.deleteMessage(d.receipt);
    });
    await new Promise((r) => setImmediate(r));
    await com.stop();
    this.startAcker();
    return got;
  }

  async requestBody(req: EnvelopeFor<"http.request">): Promise<unknown> {
    return JSON.parse((await getText(this.store, req.body.body_ref!))!);
  }

  /** Com: answer a request (body to S3, then http.response to Prime's queue). */
  async respond(requestId: string, body: string, opts: { ok?: boolean; status?: number; error?: string; errorBody?: boolean } = {}) {
    const ok = opts.ok ?? true;
    const com = this.bus.connect("com");
    com.onMessage(() => {});
    const stored = ok || opts.errorBody === true;
    if (stored) await this.store.put(responseBodyKey(requestId), body);
    com.send("prime", "http.response", {
      request_id: requestId,
      ok,
      ...(stored ? { status: opts.status ?? 200, body_ref: responseBodyKey(requestId), headers: {} } : { error: opts.error ?? "failed" }),
      elapsed_ms: 5,
    });
    await com.stop();
    this.startAcker();
  }

  async log(): Promise<LogEvent[]> {
    const keys = await this.store.list("log/");
    return Promise.all(keys.map(async (k) => (await getJSON<LogEvent>(this.store, k))!));
  }

  async latest(): Promise<number | null> {
    return (await getJSON<{ n: number }>(this.store, "prime/latest.json"))?.n ?? null;
  }

  async state(): Promise<PrimeState> {
    const n = await this.latest();
    return (await getJSON<PrimeState>(this.store, `prime/ckpt-${n}/state.json`))!;
  }

  /** Messages still in Prime's queue (not deleted), acks excluded. */
  primeQueue() {
    return this.bus.pending("prime").filter((m) => m.type !== "ack");
  }
}
