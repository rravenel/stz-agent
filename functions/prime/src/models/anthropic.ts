// Anthropic Messages API adapter. The mock model (spec §8) speaks this format
// too, so `mock` uses this adapter with auth "mock".

import { isRecord } from "../../../shared/src/guards.ts";
import {
  REPL_TOOL,
  ModelResponseError,
  parseJSON,
  type Block,
  type HttpModelRequest,
  type ModelAdapter,
  type ModelReply,
  type ModelRequest,
  type StopReason,
} from "./turn.ts";

export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";

export interface AnthropicOptions {
  model: string;
  /** Defaults to the public API. The mock uses "mock://model". */
  url?: string;
  auth?: "anthropic" | "mock";
}

function toWire(b: Block): Record<string, unknown> {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "tool_call":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input };
    case "tool_result":
      return { type: "tool_result", tool_use_id: b.tool_call_id, content: b.content, ...(b.is_error ? { is_error: true } : {}) };
  }
}

const STOP: Record<string, StopReason> = { end_turn: "end_turn", stop_sequence: "end_turn", tool_use: "tool_use", max_tokens: "max_tokens" };

export function anthropicAdapter(opts: AnthropicOptions): ModelAdapter {
  const provider = opts.auth === "mock" ? "mock" : "anthropic";
  return {
    provider,
    toRequest(req: ModelRequest): HttpModelRequest {
      const body = {
        model: opts.model,
        max_tokens: req.max_tokens,
        ...(req.system ? { system: req.system } : {}),
        // Anthropic rejects empty text blocks and messages with no content (#0014 review).
        messages: req.messages
          .map((m) => ({ role: m.role, content: m.content.filter((b) => b.type !== "text" || b.text.trim() !== "").map(toWire) }))
          .filter((m) => m.content.length > 0),
        tools: [{ name: REPL_TOOL.name, description: REPL_TOOL.description, input_schema: REPL_TOOL.input_schema }],
      };
      return {
        method: "POST",
        url: opts.url ?? ANTHROPIC_URL,
        headers: { "content-type": "application/json", "anthropic-version": ANTHROPIC_VERSION },
        body: JSON.stringify(body),
        auth: opts.auth ?? "anthropic",
      };
    },
    fromResponse(raw): ModelReply {
      const r = parseJSON(raw, provider);
      if (!isRecord(r)) throw new ModelResponseError(`${provider}: response is not an object`);
      if (r["type"] === "error") {
        const e = isRecord(r["error"]) ? r["error"] : {};
        throw new ModelResponseError(`${provider}: ${String(e["type"] ?? "error")}: ${String(e["message"] ?? "")}`);
      }
      if (!Array.isArray(r["content"])) throw new ModelResponseError(`${provider}: response has no content array`);
      const content: ModelReply["content"] = [];
      for (const b of r["content"]) {
        if (!isRecord(b)) continue;
        if (b["type"] === "text" && typeof b["text"] === "string") content.push({ type: "text", text: b["text"] });
        else if (b["type"] === "tool_use" && typeof b["id"] === "string" && typeof b["name"] === "string") {
          content.push({ type: "tool_call", id: b["id"], name: b["name"], input: isRecord(b["input"]) ? b["input"] : {} });
        }
        // Other block types (thinking, etc.) are not part of the turn.
      }
      const usage = isRecord(r["usage"]) ? r["usage"] : null;
      return {
        content,
        stop: STOP[String(r["stop_reason"])] ?? "other",
        ...(usage ? { usage: { input_tokens: Number(usage["input_tokens"] ?? 0), output_tokens: Number(usage["output_tokens"] ?? 0) } } : {}),
      };
    },
  };
}
