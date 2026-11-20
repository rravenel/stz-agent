// What a function's main thread sees of its comms worker (protocol §5–6),
// plus an in-memory fake so Prime, Com and Doorman can be built and tested
// before the real SQS worker (#0005) exists.

import { makeAck, makeEnvelope, type BodyByType, type Endpoint, type Envelope, type MessageType, type MakeOptions } from "./envelope.ts";

/** A received message plus the handle needed to delete it later. */
export interface Delivery {
  msg: Envelope;
  receipt: string;
}

export interface Comms {
  /** Who this worker serves. */
  readonly self: Endpoint;
  /**
   * Enqueue a message to `to`'s queue and track it as unacked until the
   * recipient acks it. The real worker wakes the recipient if no ack comes.
   */
  send<T extends MessageType>(to: Endpoint, type: T, body: BodyByType[T], opts?: MakeOptions): Envelope;
  /**
   * Register the main thread's handler. Every non-ack message is acked by the
   * worker *before* the handler sees it, and stays in the queue (invisible)
   * until deleteMessage is called with its receipt.
   */
  onMessage(handler: (d: Delivery) => void): void;
  /** Delete a handled message (Prime: only after a durable checkpoint). */
  deleteMessage(receipt: string): Promise<void>;
  /** Outbound messages not yet acked, across all recipients. */
  unackedCount(): number;
  /**
   * Final poll before exit: waits up to graceMs for a message. Returns true if
   * the queue stayed empty. Anything that arrives goes to the handler.
   */
  finalPoll(graceMs: number): Promise<boolean>;
  /** Stop polling and the delivery monitor. */
  stop(): Promise<void>;
}

interface Queued {
  msg: Envelope;
  receipt: string;
  /** Delivered and not yet deleted (SQS: in flight, invisible). */
  inFlight: boolean;
}

/**
 * In-memory stand-in for the three SQS queues. Connect one InMemoryComms per
 * endpoint. A comms that is stopped (or not yet connected) models a function
 * that is asleep: its messages wait in the queue until it connects again,
 * just as they wait in SQS until the function is woken.
 */
export class InMemoryBus {
  private readonly queues = new Map<Endpoint, Queued[]>();
  private readonly live = new Map<Endpoint, InMemoryComms>();
  private nextReceipt = 1;

  /** Start (or wake) `self`: in-flight messages become visible again and the queue drains. */
  connect(self: Endpoint): InMemoryComms {
    this.live.get(self)?.stopNow();
    for (const q of this.queue(self)) q.inFlight = false; // a new instance sees un-deleted messages again
    const c = new InMemoryComms(this, self);
    this.live.set(self, c);
    return c;
  }

  /** Messages still in `endpoint`'s queue (delivered or not), oldest first. */
  pending(endpoint: Endpoint): Envelope[] {
    return this.queue(endpoint).map((q) => q.msg);
  }

  /** @internal */
  enqueue(msg: Envelope): void {
    this.queue(msg.to).push({ msg, receipt: `r${this.nextReceipt++}`, inFlight: false });
    // Deliver asynchronously, like a poll: a handler never runs inside send().
    queueMicrotask(() => this.kick(msg.to));
  }

  /** @internal */
  delete(endpoint: Endpoint, receipt: string): void {
    const q = this.queue(endpoint);
    const i = q.findIndex((x) => x.receipt === receipt);
    if (i >= 0) q.splice(i, 1);
  }

  /** @internal Deliver visible messages to a live consumer, in order. */
  kick(endpoint: Endpoint): void {
    const c = this.live.get(endpoint);
    if (!c?.ready()) return;
    for (const q of this.queue(endpoint)) {
      if (q.inFlight) continue;
      q.inFlight = true;
      c.receive(q);
    }
  }

  /** @internal */
  unlink(c: InMemoryComms): void {
    if (this.live.get(c.self) === c) this.live.delete(c.self);
    for (const q of this.queue(c.self)) q.inFlight = false;
  }

  private queue(e: Endpoint): Queued[] {
    let q = this.queues.get(e);
    if (!q) this.queues.set(e, (q = []));
    return q;
  }
}

export class InMemoryComms implements Comms {
  private handler: ((d: Delivery) => void) | null = null;
  private readonly unacked = new Set<string>();
  private stopped = false;
  private arrived = 0;

  private readonly bus: InMemoryBus;
  readonly self: Endpoint;

  constructor(bus: InMemoryBus, self: Endpoint) {
    this.bus = bus;
    this.self = self;
  }

  send<T extends MessageType>(to: Endpoint, type: T, body: BodyByType[T], opts?: MakeOptions): Envelope {
    const msg = makeEnvelope(type, this.self, to, body, opts) as Envelope;
    if (type !== "ack") this.unacked.add(msg.msg_id);
    this.bus.enqueue(msg);
    return msg;
  }

  onMessage(handler: (d: Delivery) => void): void {
    this.handler = handler;
    queueMicrotask(() => this.bus.kick(this.self));
  }

  async deleteMessage(receipt: string): Promise<void> {
    this.bus.delete(this.self, receipt);
  }

  unackedCount(): number {
    return this.unacked.size;
  }

  async finalPoll(graceMs: number): Promise<boolean> {
    const before = this.arrived;
    this.bus.kick(this.self);
    await new Promise((r) => setTimeout(r, graceMs));
    return this.arrived === before;
  }

  async stop(): Promise<void> {
    this.stopNow();
  }

  /** @internal */
  stopNow(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.bus.unlink(this);
  }

  /** @internal */
  ready(): boolean {
    return !this.stopped && this.handler !== null;
  }

  /** @internal Worker-side handling of one queued message (protocol §6). */
  receive(q: Queued): void {
    const { msg } = q;
    if (msg.type === "ack") {
      this.unacked.delete(msg.body.acked_msg_id);
      this.bus.delete(this.self, q.receipt);
      return;
    }
    this.arrived++;
    this.bus.enqueue(makeAck(msg)); // ack first: "I'm awake and I have it"
    this.handler?.({ msg, receipt: q.receipt });
  }
}
