// Prime's internal, provider-neutral turn format (spec §5.3). Adapters
// translate it to and from each provider's wire format; the harness, the log
// and the checkpoint only ever see these types.

import type { AuthMode } from "../../../shared/src/envelope.ts";

export interface TextBlock {
  type: "text";
  text: string;
}

/** The model asking to run the REPL tool. */
export interface ToolCallBlock {
  type: "tool_call";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** The harness answering a tool call. */
export interface ToolResultBlock {
  type: "tool_result";
  tool_call_id: string;
  content: string;
  is_error?: boolean;
}

export type Block = TextBlock | ToolCallBlock | ToolResultBlock;

export interface Message {
  role: "user" | "assistant";
  content: Block[];
}

export interface ModelRequest {
  system?: string;
  messages: Message[];
  max_tokens: number;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "other";

export interface ModelReply {
  /** Text and tool_call blocks, in the order the model produced them. */
  content: (TextBlock | ToolCallBlock)[];
  stop: StopReason;
  usage?: { input_tokens: number; output_tokens: number };
}

/** What Prime hands to Com (as an http.request; the body goes to S3). No keys: Com adds auth. */
export interface HttpModelRequest {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  body: string;
  auth: AuthMode;
}

export interface ModelAdapter {
  readonly provider: string;
  toRequest(req: ModelRequest): HttpModelRequest;
  /** Parse a provider response body. Throws ModelResponseError on anything unusable. */
  fromResponse(body: string | Uint8Array): ModelReply;
}

export class ModelResponseError extends Error {
  override name = "ModelResponseError";
}

/** The one tool the model gets (spec §5.2): run JavaScript in the REPL. */
export const REPL_TOOL = {
  name: "repl",
  description:
    "Run JavaScript in a persistent QuickJS REPL. Your code runs as the body of an async function: use `return` " +
    "to return a value and `await` freely. Declarations (const, let, function) are local to one call; to keep " +
    "something for later calls, put it on globalThis (e.g. `globalThis.data = ...`). " +
    "Use `await fetch(url, {method, headers, body})` for HTTP (res.status, res.ok, await res.text(), await res.json()), " +
    "and the `fs` global for files under /workspace (fs.readFile, writeFile, appendFile, readdir, mkdir, rm, exists, stat; " +
    "UTF-8 text). console.log goes to stdout. There are no timers. Returns {value, stdout, stderr, error}.",
  input_schema: {
    type: "object",
    properties: { code: { type: "string", description: "JavaScript to run, as the body of an async function. Use return to return a value." } },
    required: ["code"],
  },
} as const;

export function bodyText(body: string | Uint8Array): string {
  return typeof body === "string" ? body : new TextDecoder().decode(body);
}

export function parseJSON(body: string | Uint8Array, provider: string): unknown {
  try {
    return JSON.parse(bodyText(body));
  } catch {
    throw new ModelResponseError(`${provider}: response body is not JSON`);
  }
}
