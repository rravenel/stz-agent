// Prime's append-only log (spec §4.1): one S3 object per event at
// log/<seq>.json, written with If-None-Match so an existing seq is never
// overwritten. On a conflict (after a crash: the lost run's events are still
// there) take the next free seq and record a `seq_conflict` lifecycle event.

import { logKey } from "../../shared/src/s3-keys.ts";
import type { LifecycleEvent, LogEvent, LogKind } from "../../shared/src/state.ts";
import type { ObjectStore } from "./store.ts";

export interface LogFields {
  corr_id?: string;
  msg_id?: string;
  body?: unknown;
  body_ref?: string;
}

export class LogWriter {
  /** Next seq to try. Starts at the checkpoint's next_seq. */
  next: number;
  conv: number;
  private readonly store: ObjectStore;
  private readonly run: string;
  private readonly now: () => Date;
  /** Every event written by this writer, in order (for tests and the run summary). */
  readonly written: LogEvent[] = [];

  constructor(store: ObjectStore, run: string, start: { next_seq: number; conv: number }, now: () => Date = () => new Date()) {
    this.store = store;
    this.run = run;
    this.next = start.next_seq;
    this.conv = start.conv;
    this.now = now;
  }

  /**
   * Write one event. `fields` may be a function of the seq actually written,
   * for events whose ids derive from it (model.request): on a conflict the
   * seq moves, and the id moves with it (#0013 review).
   */
  async append(kind: LogKind, fields: LogFields | ((seq: number) => LogFields) = {}): Promise<LogEvent> {
    const wanted = this.next;
    const ev = await this.write(kind, fields);
    if (ev.seq !== wanted) {
      await this.write("lifecycle", { body: { event: "seq_conflict" satisfies LifecycleEvent, wanted, got: ev.seq } });
    }
    return ev;
  }

  lifecycle(event: LifecycleEvent, extra: Record<string, unknown> = {}): Promise<LogEvent> {
    return this.append("lifecycle", { body: { event, ...extra } });
  }

  private async write(kind: LogKind, fieldsOf: LogFields | ((seq: number) => LogFields)): Promise<LogEvent> {
    for (;;) {
      const fields = typeof fieldsOf === "function" ? fieldsOf(this.next) : fieldsOf;
      const ev: LogEvent = { seq: this.next, ts: this.now().toISOString(), run: this.run, conv: this.conv, kind };
      if (fields.corr_id !== undefined) ev.corr_id = fields.corr_id;
      if (fields.msg_id !== undefined) ev.msg_id = fields.msg_id;
      if (fields.body !== undefined) ev.body = fields.body;
      if (fields.body_ref !== undefined) ev.body_ref = fields.body_ref;
      const ok = await this.store.putIfAbsent(logKey(this.next), JSON.stringify(ev));
      this.next++;
      if (ok) {
        this.written.push(ev);
        return ev;
      }
    }
  }
}
