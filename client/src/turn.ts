// One conversational turn: post the message, then poll /events until the
// turn ends. Strictly sequential: no GET while the POST is outstanding.
// (The end-of-turn rule is duplicated in scripts/e2e.ts on purpose.)

import type { Api, LogEvent } from "./api.ts";
import { formatEvent } from "./format.ts";

/** A model.response with no tool_call block, or an error at model.response. */
export function isEndOfTurn(ev: LogEvent): "end_turn" | "error" | null {
  const b = (ev.body ?? {}) as { content?: unknown; where?: unknown };
  if (ev.kind === "model.response" && Array.isArray(b.content)) {
    return b.content.some((c) => (c as { type?: unknown })?.type === "tool_call") ? null : "end_turn";
  }
  if (ev.kind === "error" && b.where === "model.response") return "error";
  return null;
}

export interface TurnOptions {
  print: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  timeoutMs?: number;
  after?: number;
  msgId?: string;
  tty?: boolean;
}

export async function runTurn(
  api: Api,
  text: string,
  o: TurnOptions,
): Promise<{ after: number; ended: "end_turn" | "error" | "timeout" }> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const pollMs = o.pollMs ?? 1500;
  const deadline = now() + (o.timeoutMs ?? 15 * 60_000);
  const { msg_id } = await api.postMessage(text, o.msgId);
  let after = o.after ?? -1;
  let seenOurs = false;
  while (now() < deadline) {
    const page = await api.events(after);
    for (const ev of page.events) {
      o.print(formatEvent(ev, o.tty ?? false));
      if (ev.kind === "user.message" && ev.msg_id === msg_id) seenOurs = true;
      else if (seenOurs) {
        const end = isEndOfTurn(ev);
        if (end) return { after: Math.max(after, ev.seq), ended: end };
      }
    }
    after = page.next_after;
    if (!page.more) await sleep(pollMs);
  }
  return { after, ended: "timeout" };
}
