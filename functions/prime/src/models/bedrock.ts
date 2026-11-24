// Amazon Bedrock Converse API adapter. Com signs the request (SigV4, its own
// role); Prime only builds it.

import { isRecord } from "../../../shared/src/guards.ts";
import {
  REPL_TOOL,
  ModelResponseError,
  parseJSON,
  type Block,
  type HttpModelRequest,
  type Message,
  type ModelAdapter,
  type ModelReply,
  type ModelRequest,
  type StopReason,
} from "./turn.ts";

export interface BedrockOptions {
  /** Foundation-model id or system inference-profile id (what Com's IAM policy allows). */
  model: string;
  region: string;
}

function toWire(b: Block): Record<string, unknown> {
  switch (b.type) {
    case "text":
      return { text: b.text };
    case "tool_call":
      return { toolUse: { toolUseId: b.id, name: b.name, input: b.input } };
    case "tool_result":
      // Converse rejects blank text.
      return {
        toolResult: {
          toolUseId: b.tool_call_id,
          content: [{ text: b.content.trim() === "" ? "(empty)" : b.content }],
          ...(b.is_error ? { status: "error" } : {}),
        },
      };
  }
}

/** Converse wants alternating roles, no empty messages and no blank text. */
function wireMessages(messages: Message[]): { role: string; content: Record<string, unknown>[] }[] {
  const out: { role: string; content: Record<string, unknown>[] }[] = [];
  for (const m of messages) {
    const content = m.content.filter((b) => b.type !== "text" || b.text.trim() !== "").map(toWire);
    if (content.length === 0) continue;
    const last = out.at(-1);
    if (last?.role === m.role) last.content.push(...content);
    else out.push({ role: m.role, content });
  }
  return out;
}

const STOP = new Map<string, StopReason>([
  ["end_turn", "end_turn"],
  ["stop_sequence", "end_turn"],
  ["tool_use", "tool_use"],
  ["max_tokens", "max_tokens"],
]);

export function bedrockAdapter(opts: BedrockOptions): ModelAdapter {
  const url = `https://bedrock-runtime.${opts.region}.amazonaws.com/model/${encodeURIComponent(opts.model)}/converse`;
  return {
    provider: "bedrock",
    toRequest(req: ModelRequest): HttpModelRequest {
      const body = {
        ...(req.system ? { system: [{ text: req.system }] } : {}),
        messages: wireMessages(req.messages),
        inferenceConfig: { maxTokens: req.max_tokens },
        toolConfig: {
          tools: [{ toolSpec: { name: REPL_TOOL.name, description: REPL_TOOL.description, inputSchema: { json: REPL_TOOL.input_schema } } }],
        },
      };
      return { method: "POST", url, headers: { "content-type": "application/json" }, body: JSON.stringify(body), auth: "bedrock" };
    },
    fromResponse(raw): ModelReply {
      const r = parseJSON(raw, "bedrock");
      if (!isRecord(r)) throw new ModelResponseError("bedrock: response is not an object");
      const message = isRecord(r["output"]) ? r["output"]["message"] : undefined;
      if (!isRecord(message) || !Array.isArray(message["content"])) {
        const why = r["message"] ?? r["Message"];
        throw new ModelResponseError(`bedrock: ${typeof why === "string" ? why : "response has no output.message.content"}`);
      }
      const content: ModelReply["content"] = [];
      for (const b of message["content"]) {
        if (!isRecord(b)) continue;
        const t = b["toolUse"];
        if (typeof b["text"] === "string") content.push({ type: "text", text: b["text"] });
        else if (isRecord(t) && typeof t["toolUseId"] === "string" && typeof t["name"] === "string") {
          content.push({ type: "tool_call", id: t["toolUseId"], name: t["name"], input: isRecord(t["input"]) ? t["input"] : {} });
        }
        // Other block types (reasoningContent, etc.) are not part of the turn.
      }
      const stop = String(r["stopReason"]);
      // An empty reply would be dropped from the context and the same (billed) call sent again.
      if (!content.some((b) => b.type === "tool_call" || b.text.trim() !== "")) {
        throw new ModelResponseError(`bedrock: empty reply (stop reason ${stop})`);
      }
      const usage = isRecord(r["usage"]) ? r["usage"] : null;
      return {
        content,
        stop: STOP.get(stop) ?? "other",
        ...(usage ? { usage: { input_tokens: Number(usage["inputTokens"] ?? 0), output_tokens: Number(usage["outputTokens"] ?? 0) } } : {}),
      };
    },
  };
}
