// One line per log event. ANSI dim only on a TTY; no colour dependency.

import type { LogEvent } from "./api.ts";

const MAX = 200;
const trunc = (s: string, n = MAX) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstLine = (s: string) => s.split("\n")[0] ?? "";

export function formatEvent(ev: LogEvent, tty = false): string {
  const b = (ev.body ?? {}) as Record<string, unknown>;
  const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
  switch (ev.kind) {
    case "user.message":
      return `you: ${String(b["text"] ?? "")}`;
    case "model.response": {
      const content = Array.isArray(b["content"]) ? (b["content"] as Record<string, unknown>[]) : [];
      const parts: string[] = [];
      for (const c of content) {
        if (c["type"] === "text") parts.push(String(c["text"] ?? ""));
        else if (c["type"] === "tool_call") {
          const code = (c["input"] as { code?: unknown } | undefined)?.code;
          parts.push(`→ ${String(c["name"] ?? "tool")}(${trunc(firstLine(typeof code === "string" ? code : ""), 80)})`);
        }
      }
      return parts.join(" ");
    }
    case "tool.result": {
      const text = trunc(String(b["content"] ?? ""));
      return b["is_error"] ? `← error: ${text}` : `← ${text}`;
    }
    case "http.request":
      return dim(`· com ${String(b["purpose"] ?? "?")} ${String(b["method"] ?? "")} ${trunc(String(b["url"] ?? ""), 80)}`.trimEnd());
    case "http.response": {
      const status = b["status"] ?? (b["ok"] === false ? "failed" : "?");
      const el = typeof b["elapsed_ms"] === "number" ? ` ${(b["elapsed_ms"] / 1000).toFixed(1)}s` : "";
      const err = b["error"] ? ` ${trunc(String(b["error"]), 80)}` : "";
      return dim(`· com ${String(b["purpose"] ?? "?")} ${String(status)}${el}${err}`);
    }
    case "lifecycle":
      return dim(`· prime ${String(b["event"] ?? "?")}${b["reason"] !== undefined ? ` (${String(b["reason"])})` : ""}`);
    case "error":
      return `! ${trunc(String(b["message"] ?? "error"))}`;
    default:
      return dim(`· ${ev.kind}`);
  }
}
