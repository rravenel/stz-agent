// OpenAI Chat Completions adapter: any compatible endpoint (OpenAI, vLLM,
// Ollama, OpenRouter …), configured by base URL and model name.

import { isRecord } from "../../../shared/src/guards.ts";
import {
  REPL_TOOL,
  ModelResponseError,
  parseJSON,
  type HttpModelRequest,
  type Message,
  type ModelAdapter,
  type ModelReply,
  type ModelRequest,
  type StopReason,
} from "./turn.ts";

export interface OpenAIOptions {
  model: string;
  /** e.g. https://api.openai.com/v1 or http://localhost:11434/v1 */
  baseUrl: string;
  /**
   * Name of the output-limit field. OpenAI's own API wants
   * "max_completion_tokens" for newer models; most compatible servers take
   * "max_tokens" (the default).
   */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
}

/** One internal message can become several wire messages (each tool result is its own "tool" message). */
function toWire(m: Message): Record<string, unknown>[] {
  const text = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
  if (m.role === "assistant") {
    const calls = m.content.flatMap((b) =>
      b.type === "tool_call" ? [{ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } }] : [],
    );
    return [{ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) }];
  }
  const out: Record<string, unknown>[] = m.content.flatMap((b) =>
    b.type === "tool_result" ? [{ role: "tool", tool_call_id: b.tool_call_id, content: b.is_error ? `Error: ${b.content}` : b.content }] : [],
  );
  if (text) out.push({ role: "user", content: text });
  return out;
}

const STOP: Record<string, StopReason> = { stop: "end_turn", tool_calls: "tool_use", function_call: "tool_use", length: "max_tokens" };

export function openaiAdapter(opts: OpenAIOptions): ModelAdapter {
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return {
    provider: "openai",
    toRequest(req: ModelRequest): HttpModelRequest {
      const messages = [...(req.system ? [{ role: "system", content: req.system }] : []), ...req.messages.flatMap(toWire)];
      const body = {
        model: opts.model,
        [opts.maxTokensField ?? "max_tokens"]: req.max_tokens,
        messages,
        tools: [{ type: "function", function: { name: REPL_TOOL.name, description: REPL_TOOL.description, parameters: REPL_TOOL.input_schema } }],
      };
      return { method: "POST", url, headers: { "content-type": "application/json" }, body: JSON.stringify(body), auth: "openai" };
    },
    fromResponse(raw): ModelReply {
      const r = parseJSON(raw, "openai");
      if (!isRecord(r)) throw new ModelResponseError("openai: response is not an object");
      if (isRecord(r["error"])) throw new ModelResponseError(`openai: ${String(r["error"]["message"] ?? "error")}`);
      const choice = Array.isArray(r["choices"]) ? r["choices"][0] : undefined;
      if (!isRecord(choice) || !isRecord(choice["message"])) throw new ModelResponseError("openai: response has no choices[0].message");
      const msg = choice["message"];
      const content: ModelReply["content"] = [];
      if (typeof msg["content"] === "string" && msg["content"]) content.push({ type: "text", text: msg["content"] });
      for (const c of Array.isArray(msg["tool_calls"]) ? msg["tool_calls"] : []) {
        if (!isRecord(c) || !isRecord(c["function"]) || typeof c["id"] !== "string") continue;
        const args = c["function"]["arguments"];
        let input: Record<string, unknown>;
        try {
          const parsed: unknown = typeof args === "string" ? JSON.parse(args) : args;
          input = isRecord(parsed) ? parsed : {};
        } catch {
          // Models sometimes emit broken JSON; keep the raw text so the REPL error explains it.
          input = { code: String(args), _invalid_json: true };
        }
        content.push({ type: "tool_call", id: c["id"], name: String(c["function"]["name"]), input });
      }
      const usage = isRecord(r["usage"]) ? r["usage"] : null;
      return {
        content,
        stop: STOP[String(choice["finish_reason"])] ?? "other",
        ...(usage ? { usage: { input_tokens: Number(usage["prompt_tokens"] ?? 0), output_tokens: Number(usage["completion_tokens"] ?? 0) } } : {}),
      };
    },
  };
}
