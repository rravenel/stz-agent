// GET /events: read log/ objects from S3. Never touches queues or invokes anything.

import { LOG_PREFIX, logKey, seqFromLogKey } from "../../shared/src/s3-keys.ts";

export interface LogStore {
  list(opts: { prefix: string; startAfter?: string; maxKeys: number }): Promise<{ keys: string[]; truncated: boolean }>;
  getText(key: string): Promise<string>;
}

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;
const FETCH_CONCURRENCY = 10;

export interface EventsPage {
  events: unknown[];
  next_after: number;
  more: boolean;
}

/** Parse `after` / `limit` query values; null means 400. */
export function parseEventsQuery(q: Record<string, string>): { after: number; limit: number } | null {
  const int = (s: string | undefined, dflt: number) => (s === undefined ? dflt : /^-?\d+$/.test(s) ? Number(s) : NaN);
  const after = int(q["after"], -1);
  const limit = int(q["limit"], DEFAULT_LIMIT);
  if (!Number.isSafeInteger(after) || after < -1) return null;
  if (!Number.isSafeInteger(limit) || limit < 1) return null;
  return { after, limit: Math.min(limit, MAX_LIMIT) };
}

export async function listEvents(store: LogStore, after: number, limit: number, warn: (o: object) => void = () => {}): Promise<EventsPage> {
  const listed = await store.list({
    prefix: LOG_PREFIX,
    ...(after >= 0 ? { startAfter: logKey(after) } : {}),
    maxKeys: limit,
  });
  const seqs = listed.keys.flatMap((k) => {
    const s = seqFromLogKey(k);
    return s === null ? [] : [{ key: k, seq: s }];
  });
  const results: (unknown | undefined)[] = new Array(seqs.length);
  let next = 0;
  async function worker() {
    while (next < seqs.length) {
      const i = next++;
      const { key, seq } = seqs[i]!;
      try {
        results[i] = JSON.parse(await store.getText(key));
      } catch (e) {
        warn({ kind: "corrupt-event", seq, error: String(e) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, seqs.length) }, worker));
  return {
    events: results.filter((r) => r !== undefined),
    next_after: seqs.length ? seqs[seqs.length - 1]!.seq : after,
    more: listed.truncated,
  };
}
