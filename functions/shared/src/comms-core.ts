// The comms logic of protocol §5–6, free of AWS: polling, immediate acks, the
// per-recipient unacked sets and the delivery monitor that sync-wakes a
// recipient until its ack arrives. AWS lives behind QueuePort and WakePort.

import type { Comms, Delivery } from "./comms.ts";
import { makeAck, makeEnvelope, parseEnvelope, type BodyByType, type Endpoint, type Envelope, type MakeOptions, type MessageType } from "./envelope.ts";

export interface QueuePort {
  /** Long-poll own queue for up to waitSeconds. */
  receive(waitSeconds: number): Promise<{ body: string; receipt: string }[]>;
  send(to: Endpoint, msg: Envelope): Promise<void>;
  delete(receipt: string): Promise<void>;
}

export type WakeKind = "running" | "started" | "failed" | "error";
export interface WakeResult {
  kind: WakeKind;
  detail?: string;
}
export interface WakePort {
  wake(to: Endpoint): Promise<WakeResult>;
}

export type LogEvent =
  | { kind: "wake"; to: Endpoint; result: WakeResult }
  | { kind: "poison"; error: string }
  | { kind: "send-failed"; to: Endpoint; msg_id: string; error: string }
  | { kind: "poll-failed"; error: string }
  | { kind: "declined"; msg_id: string; reason: "deadline" };
export type Logger = (event: LogEvent) => void;

export interface CommsOptions {
  ackTimeoutMs: number;
  wakeAckTimeoutMs: Record<Endpoint, number>;
  tickMs: number;
  pollWaitSeconds: number;
  /**
   * Com only (spec §6, protocol §8): an http.request whose timeout would end
   * after this epoch-ms is left unacked, unhandled and undeleted, so it
   * reappears for the next Com. Unset: every message is acked.
   */
  acceptDeadlineAtMs?: number;
}

export const DEFAULT_OPTIONS: CommsOptions = {
  ackTimeoutMs: 3000,
  wakeAckTimeoutMs: { prime: 15000, com: 5000, doorman: 5000 },
  tickMs: 500,
  pollWaitSeconds: 2,
};

export function withDefaults(o: Partial<CommsOptions> = {}): CommsOptions {
  return { ...DEFAULT_OPTIONS, ...o, wakeAckTimeoutMs: { ...DEFAULT_OPTIONS.wakeAckTimeoutMs, ...o.wakeAckTimeoutMs } };
}

interface Recipient {
  /** msg_id → sent_at (ms). Insertion order is send order. */
  unacked: Map<string, number>;
  lastWakeAt: number | null;
}

/** Protocol §5, pure: time is passed in. */
export class DeliveryMonitor {
  private readonly recipients = new Map<Endpoint, Recipient>();
  private readonly owner = new Map<string, Endpoint>();
  private readonly opts: Pick<CommsOptions, "ackTimeoutMs" | "wakeAckTimeoutMs">;

  constructor(opts: Pick<CommsOptions, "ackTimeoutMs" | "wakeAckTimeoutMs"> = DEFAULT_OPTIONS) {
    this.opts = opts;
  }

  track(to: Endpoint, msgId: string, now: number): void {
    let r = this.recipients.get(to);
    if (!r) this.recipients.set(to, (r = { unacked: new Map(), lastWakeAt: null }));
    r.unacked.set(msgId, now);
    this.owner.set(msgId, to);
  }

  /** Returns true if msgId was being tracked. */
  ack(msgId: string): boolean {
    const to = this.owner.get(msgId);
    if (!to) return false;
    this.owner.delete(msgId);
    const r = this.recipients.get(to);
    r?.unacked.delete(msgId);
    if (r && r.unacked.size === 0) this.recipients.delete(to); // resets lastWakeAt
    return true;
  }

  due(now: number): Endpoint[] {
    const out: Endpoint[] = [];
    for (const [to, r] of this.recipients) {
      const oldest = r.unacked.values().next().value as number;
      const waited = now - (r.lastWakeAt ?? oldest);
      const limit = r.lastWakeAt === null ? this.opts.ackTimeoutMs : this.opts.wakeAckTimeoutMs[to];
      if (waited > limit) out.push(to);
    }
    return out;
  }

  markWoken(to: Endpoint, now: number): void {
    const r = this.recipients.get(to);
    if (r) r.lastWakeAt = now;
  }

  count(): number {
    return this.owner.size;
  }
}

/** Comms over ports. Runs on whichever thread owns the ports. */
export class CommsCore implements Comms {
  readonly self: Endpoint;
  private readonly queue: QueuePort;
  private readonly waker: WakePort;
  private readonly log: Logger;
  private readonly opts: CommsOptions;
  private readonly monitor: DeliveryMonitor;
  private handler: ((d: Delivery) => void) | null = null;
  private held: Delivery[] = [];
  private readonly outbox: Envelope[] = [];
  private readonly waking = new Set<Endpoint>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private polling: Promise<void> | null = null;
  private arrived = 0;
  /** Called whenever unackedCount() may have changed. */
  onCountChange: ((n: number) => void) | null = null;

  constructor(self: Endpoint, queue: QueuePort, waker: WakePort, log: Logger = () => {}, opts: Partial<CommsOptions> = {}) {
    this.self = self;
    this.queue = queue;
    this.waker = waker;
    this.log = log;
    this.opts = withDefaults(opts);
    this.monitor = new DeliveryMonitor(this.opts);
  }

  /** Start the poll loop and the monitor tick. */
  start(): this {
    if (this.timer || this.stopped) return this;
    this.timer = setInterval(() => this.tick(), this.opts.tickMs);
    this.polling = this.pollLoop();
    return this;
  }

  send<T extends MessageType>(to: Endpoint, type: T, body: BodyByType[T], opts?: MakeOptions): Envelope {
    const msg = makeEnvelope(type, this.self, to, body, opts) as Envelope;
    this.sendEnvelope(msg);
    return msg;
  }

  /** Enqueue a prebuilt envelope (used by the worker, where main builds it). */
  sendEnvelope(msg: Envelope): void {
    if (msg.type !== "ack") {
      this.monitor.track(msg.to, msg.msg_id, Date.now());
      this.countChanged();
    }
    void this.enqueue(msg);
  }

  onMessage(handler: (d: Delivery) => void): void {
    this.handler = handler;
    const held = this.held;
    this.held = [];
    for (const d of held) handler(d);
  }

  deleteMessage(receipt: string): Promise<void> {
    return this.queue.delete(receipt);
  }

  unackedCount(): number {
    return this.monitor.count();
  }

  async finalPoll(graceMs: number): Promise<boolean> {
    const before = this.arrived;
    await this.pollOnce(Math.ceil(graceMs / 1000));
    return this.arrived === before;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.polling;
  }

  /** One monitor tick: retry failed sends, then wake due recipients. */
  tick(): void {
    for (const msg of this.outbox.splice(0)) void this.enqueue(msg);
    const now = Date.now();
    for (const to of this.monitor.due(now)) {
      if (this.waking.has(to)) continue;
      this.waking.add(to);
      this.monitor.markWoken(to, now);
      this.waker
        .wake(to)
        .catch((e: unknown): WakeResult => ({ kind: "error", detail: String(e) }))
        .then((result) => this.log({ kind: "wake", to, result })) // never clears an entry
        .finally(() => this.waking.delete(to));
    }
  }

  private async enqueue(msg: Envelope): Promise<void> {
    try {
      await this.queue.send(msg.to, msg);
    } catch (e) {
      this.log({ kind: "send-failed", to: msg.to, msg_id: msg.msg_id, error: String(e) });
      this.outbox.push(msg);
    }
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped) await this.pollOnce(this.opts.pollWaitSeconds);
  }

  private async pollOnce(waitSeconds: number): Promise<void> {
    let batch: { body: string; receipt: string }[];
    try {
      batch = await this.queue.receive(waitSeconds);
    } catch (e) {
      this.log({ kind: "poll-failed", error: String(e) });
      await new Promise((r) => setTimeout(r, this.opts.tickMs));
      return;
    }
    for (const m of batch) await this.handle(m.body, m.receipt);
  }

  private async handle(raw: string, receipt: string): Promise<void> {
    const r = parseEnvelope(raw);
    if (!r.ok) {
      this.log({ kind: "poison", error: r.error });
      await this.queue.delete(receipt).catch(() => {});
      return;
    }
    const msg = r.value;
    if (msg.type === "ack") {
      if (this.monitor.ack(msg.body.acked_msg_id)) this.countChanged();
      await this.queue.delete(receipt).catch(() => {});
      return;
    }
    const deadline = this.opts.acceptDeadlineAtMs;
    if (msg.type === "http.request" && deadline !== undefined && Date.now() + msg.body.timeout_s * 1000 > deadline) {
      this.log({ kind: "declined", msg_id: msg.msg_id, reason: "deadline" });
      return; // not counted as arrived: finalPoll may still report empty
    }
    this.arrived++;
    await this.enqueue(makeAck(msg)); // ack first: "I'm awake and I have it"
    const d = { msg, receipt };
    if (this.handler) this.handler(d);
    else this.held.push(d);
  }

  private countChanged(): void {
    this.onCountChange?.(this.monitor.count());
  }
}
