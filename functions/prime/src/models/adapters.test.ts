import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicAdapter, ANTHROPIC_URL } from "./anthropic.ts";
import { bedrockAdapter } from "./bedrock.ts";
import { openaiAdapter } from "./openai.ts";
import { adapterFromEnv, MOCK_URL } from "./config.ts";
import { ModelResponseError, type Message, type ModelRequest } from "./turn.ts";

// A full tool round trip in the internal format: user asks, model calls the
// REPL, harness returns the result, and the next request carries all of it.
const conversation: Message[] = [
  { role: "user", content: [{ type: "text", text: "What is 6*7?" }] },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Let me compute it." },
      { type: "tool_call", id: "call_1", name: "repl", input: { code: "6*7" } },
    ],
  },
  { role: "user", content: [{ type: "tool_result", tool_call_id: "call_1", content: '{"value":42}' }] },
];
const req: ModelRequest = { system: "You are terse.", messages: conversation, max_tokens: 1024 };

// --- Anthropic -------------------------------------------------------------

test("anthropic request: URL, headers, no keys, tool definition, tool round trip", () => {
  const a = anthropicAdapter({ model: "claude-sonnet-5-5" });
  const r = a.toRequest(req);
  assert.equal(r.url, ANTHROPIC_URL);
  assert.equal(r.auth, "anthropic");
  assert.deepEqual(r.headers, { "content-type": "application/json", "anthropic-version": "2023-06-01" });
  assert.ok(!Object.keys(r.headers).some((h) => /key|authorization/i.test(h)), "Prime never sends keys");
  const body = JSON.parse(r.body);
  assert.equal(body.model, "claude-sonnet-5-5");
  assert.equal(body.system, "You are terse.");
  assert.equal(body.tools[0].name, "repl");
  assert.deepEqual(body.tools[0].input_schema.required, ["code"]);
  assert.deepEqual(body.messages[1].content[1], { type: "tool_use", id: "call_1", name: "repl", input: { code: "6*7" } });
  assert.deepEqual(body.messages[2], { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: '{"value":42}' }] });
});

test("anthropic response: tool_use becomes a tool_call; usage and stop reason map", () => {
  const fixture = {
    id: "msg_01", type: "message", role: "assistant", model: "claude-sonnet-5-5",
    content: [
      { type: "text", text: "Running it." },
      { type: "tool_use", id: "toolu_01", name: "repl", input: { code: "await fetch('https://example.com')" } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 120, output_tokens: 33 },
  };
  const reply = anthropicAdapter({ model: "m" }).fromResponse(new TextEncoder().encode(JSON.stringify(fixture)));
  assert.equal(reply.stop, "tool_use");
  assert.deepEqual(reply.usage, { input_tokens: 120, output_tokens: 33 });
  assert.deepEqual(reply.content, [
    { type: "text", text: "Running it." },
    { type: "tool_call", id: "toolu_01", name: "repl", input: { code: "await fetch('https://example.com')" } },
  ]);
});

test("anthropic response: end_turn text, unknown blocks skipped, errors raised", () => {
  const a = anthropicAdapter({ model: "m" });
  const reply = a.fromResponse(JSON.stringify({ content: [{ type: "thinking", thinking: "…" }, { type: "text", text: "42" }], stop_reason: "end_turn" }));
  assert.deepEqual(reply, { content: [{ type: "text", text: "42" }], stop: "end_turn" });
  assert.throws(() => a.fromResponse(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } })), /overloaded_error: busy/);
  assert.throws(() => a.fromResponse("<html>502</html>"), ModelResponseError);
  assert.throws(() => a.fromResponse(JSON.stringify({ stop_reason: "end_turn" })), /no content array/);
});

// --- OpenAI-compatible -----------------------------------------------------

test("openai request: system message, tool_calls with JSON arguments, tool messages", () => {
  const r = openaiAdapter({ model: "gpt-x", baseUrl: "http://localhost:11434/v1/" }).toRequest(req);
  assert.equal(r.url, "http://localhost:11434/v1/chat/completions");
  assert.equal(r.auth, "openai");
  assert.deepEqual(r.headers, { "content-type": "application/json" });
  const body = JSON.parse(r.body);
  assert.deepEqual(body.messages[0], { role: "system", content: "You are terse." });
  assert.deepEqual(body.messages[1], { role: "user", content: "What is 6*7?" });
  assert.deepEqual(body.messages[2], {
    role: "assistant",
    content: "Let me compute it.",
    tool_calls: [{ id: "call_1", type: "function", function: { name: "repl", arguments: '{"code":"6*7"}' } }],
  });
  assert.deepEqual(body.messages[3], { role: "tool", tool_call_id: "call_1", content: '{"value":42}' });
  assert.equal(body.tools[0].function.name, "repl");
});

test("openai response: tool_calls parsed, finish_reason and usage mapped, bad arguments kept", () => {
  const o = openaiAdapter({ model: "m", baseUrl: "https://api.openai.com/v1" });
  const fixture = {
    id: "chatcmpl-1", object: "chat.completion",
    choices: [{
      index: 0, finish_reason: "tool_calls",
      message: { role: "assistant", content: null, tool_calls: [
        { id: "call_a", type: "function", function: { name: "repl", arguments: '{"code":"1+1"}' } },
        { id: "call_b", type: "function", function: { name: "repl", arguments: '{"code": "oops' } },
      ] },
    }],
    usage: { prompt_tokens: 50, completion_tokens: 9, total_tokens: 59 },
  };
  const reply = o.fromResponse(JSON.stringify(fixture));
  assert.equal(reply.stop, "tool_use");
  assert.deepEqual(reply.usage, { input_tokens: 50, output_tokens: 9 });
  assert.deepEqual(reply.content[0], { type: "tool_call", id: "call_a", name: "repl", input: { code: "1+1" } });
  assert.deepEqual(reply.content[1], { type: "tool_call", id: "call_b", name: "repl", input: { code: '{"code": "oops', _invalid_json: true } });
  assert.deepEqual(o.fromResponse(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "2" } }] })), { content: [{ type: "text", text: "2" }], stop: "end_turn" });
  assert.throws(() => o.fromResponse(JSON.stringify({ error: { message: "rate limited" } })), /rate limited/);
  assert.throws(() => o.fromResponse(JSON.stringify({ choices: [] })), /no choices/);
});

test("an error tool result is marked for both providers", () => {
  const errReq: ModelRequest = { max_tokens: 10, messages: [{ role: "user", content: [{ type: "tool_result", tool_call_id: "c", content: "ReferenceError", is_error: true }] }] };
  const a = JSON.parse(anthropicAdapter({ model: "m" }).toRequest(errReq).body);
  assert.equal(a.messages[0].content[0].is_error, true);
  const o = JSON.parse(openaiAdapter({ model: "m", baseUrl: "http://x/v1" }).toRequest(errReq).body);
  assert.equal(o.messages[0].content, "Error: ReferenceError");
});

// --- Config ----------------------------------------------------------------

test("adapterFromEnv picks the provider and refuses bad config", () => {
  const mock = adapterFromEnv({ MODEL_PROVIDER: "mock" });
  assert.equal(mock.provider, "mock");
  const m = mock.toRequest(req);
  assert.equal(m.url, MOCK_URL);
  assert.equal(m.auth, "mock");
  assert.equal(adapterFromEnv({ MODEL_PROVIDER: "anthropic", MODEL_NAME: "claude-sonnet-5-5" }).provider, "anthropic");
  assert.equal(adapterFromEnv({ MODEL_PROVIDER: "openai", MODEL_NAME: "m", OPENAI_BASE_URL: "https://api.openai.com/v1" }).provider, "openai");
  assert.throws(() => adapterFromEnv({ MODEL_PROVIDER: "anthropic" }), /MODEL_NAME/);
  assert.throws(() => adapterFromEnv({ MODEL_PROVIDER: "openai", MODEL_NAME: "m" }), /OPENAI_BASE_URL/);
  assert.throws(() => adapterFromEnv({ MODEL_PROVIDER: "bedrock", MODEL_NAME: "m" }), /AWS_REGION/);
  assert.match(adapterFromEnv({ MODEL_PROVIDER: "bedrock", MODEL_NAME: "m", AWS_REGION: "us-west-2" }).toRequest(req).url, /us-west-2/);
  assert.match(adapterFromEnv({ MODEL_PROVIDER: "bedrock", MODEL_NAME: "m", AWS_REGION: "us-west-2", BEDROCK_REGION: "us-east-1" }).toRequest(req).url, /us-west-2/);
  assert.throws(() => adapterFromEnv({ MODEL_PROVIDER: "bedrock", MODEL_NAME: "m", AWS_REGION: "evil.com/x" }), /AWS_REGION/);
  assert.throws(() => adapterFromEnv({}), /MODEL_PROVIDER/);
});

// --- #0014 review notes ------------------------------------------------------

test("anthropic request drops empty text blocks and messages left empty", () => {
  const r: ModelRequest = {
    max_tokens: 10,
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }, { type: "text", text: "  " }] },
      { role: "assistant", content: [{ type: "text", text: "" }] },
      { role: "assistant", content: [{ type: "text", text: "" }, { type: "tool_call", id: "c1", name: "repl", input: { code: "1" } }] },
    ],
  };
  const body = JSON.parse(anthropicAdapter({ model: "m" }).toRequest(r).body);
  assert.deepEqual(body.messages, [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "repl", input: { code: "1" } }] },
  ]);
});

test("openai output-limit field is configurable (max_tokens by default)", () => {
  const plain = JSON.parse(openaiAdapter({ model: "m", baseUrl: "http://x/v1" }).toRequest(req).body);
  assert.equal(plain.max_tokens, 1024);
  assert.equal(plain.max_completion_tokens, undefined);
  const env = { MODEL_PROVIDER: "openai", MODEL_NAME: "m", OPENAI_BASE_URL: "https://api.openai.com/v1", OPENAI_MAX_TOKENS_FIELD: "max_completion_tokens" };
  const newer = JSON.parse(adapterFromEnv(env).toRequest(req).body);
  assert.equal(newer.max_completion_tokens, 1024);
  assert.equal(newer.max_tokens, undefined);
  assert.throws(() => adapterFromEnv({ ...env, OPENAI_MAX_TOKENS_FIELD: "tokens" }), /OPENAI_MAX_TOKENS_FIELD/);
});

test("the repl tool description matches how evals run (return, globalThis, no last-expression value)", () => {
  const body = JSON.parse(anthropicAdapter({ model: "m" }).toRequest(req).body);
  const d: string = body.tools[0].description;
  assert.match(d, /use `return`/);
  assert.match(d, /globalThis/);
  assert.doesNotMatch(d, /last expression/);
  assert.doesNotMatch(JSON.stringify(body.tools[0].input_schema), /last expression/);
});

// --- Bedrock (#0021) --------------------------------------------------------

const bedrock = bedrockAdapter({ model: "us.vendor.model-v1:0", region: "us-west-2" });

test("bedrock request: Converse URL, auth mode, no keys, tool round trip", () => {
  const r = bedrock.toRequest(req);
  assert.equal(r.url, "https://bedrock-runtime.us-west-2.amazonaws.com/model/us.vendor.model-v1%3A0/converse");
  assert.equal(r.auth, "bedrock");
  assert.deepEqual(r.headers, { "content-type": "application/json" });
  const b = JSON.parse(r.body);
  assert.deepEqual(b.system, [{ text: "You are terse." }]);
  assert.deepEqual(b.inferenceConfig, { maxTokens: 1024 });
  assert.equal(b.toolConfig.tools[0].toolSpec.name, "repl");
  assert.deepEqual(b.toolConfig.tools[0].toolSpec.inputSchema.json.required, ["code"]);
  assert.deepEqual(b.messages[1].content[1], { toolUse: { toolUseId: "call_1", name: "repl", input: { code: "6*7" } } });
  assert.deepEqual(b.messages[2], { role: "user", content: [{ toolResult: { toolUseId: "call_1", content: [{ text: '{"value":42}' }] } }] });
});

test("bedrock request: merges same-role messages, drops blank text, marks errors", () => {
  const b = JSON.parse(
    bedrock.toRequest({
      max_tokens: 1,
      messages: [
        { role: "user", content: [{ type: "text", text: "a" }] },
        { role: "user", content: [{ type: "text", text: "b" }] },
        { role: "assistant", content: [{ type: "text", text: " " }] },
        { role: "user", content: [{ type: "tool_result", tool_call_id: "t", content: "", is_error: true }] },
      ],
    }).body,
  );
  assert.deepEqual(b.messages, [
    { role: "user", content: [{ text: "a" }, { text: "b" }, { toolResult: { toolUseId: "t", content: [{ text: "(empty)" }], status: "error" } }] },
  ]);
  assert.ok(!("system" in b));
});

test("bedrock response: text, toolUse, usage and stop map; other blocks skipped", () => {
  const reply = bedrock.fromResponse(
    JSON.stringify({
      output: { message: { role: "assistant", content: [{ reasoningContent: {} }, { text: "Hi" }, { toolUse: { toolUseId: "t1", name: "repl", input: { code: "1" } } }] } },
      stopReason: "tool_use",
      usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
    }),
  );
  assert.deepEqual(reply, {
    content: [{ type: "text", text: "Hi" }, { type: "tool_call", id: "t1", name: "repl", input: { code: "1" } }],
    stop: "tool_use",
    usage: { input_tokens: 5, output_tokens: 7 },
  });
});

test("bedrock response: errors raised", () => {
  assert.throws(() => bedrock.fromResponse('{"message":"Access denied"}'), /bedrock: Access denied/);
  assert.throws(() => bedrock.fromResponse("{}"), ModelResponseError);
  assert.throws(() => bedrock.fromResponse("nope"), ModelResponseError);
});

test("bedrock response: stop reasons, odd tool input, Message errors, and empty replies raise", () => {
  const body = (stopReason: string, content: unknown[] = [{ text: "x" }]) => JSON.stringify({ output: { message: { content } }, stopReason });
  for (const [wire, stop] of [["end_turn", "end_turn"], ["stop_sequence", "end_turn"], ["tool_use", "tool_use"], ["max_tokens", "max_tokens"], ["guardrail_intervened", "other"], ["constructor", "other"]] as const) {
    assert.equal(bedrock.fromResponse(body(wire)).stop, stop, wire);
  }
  assert.deepEqual(bedrock.fromResponse(body("tool_use", [{ toolUse: { toolUseId: "t", name: "repl", input: "str" } }])).content, [
    { type: "tool_call", id: "t", name: "repl", input: {} },
  ]);
  assert.throws(() => bedrock.fromResponse('{"Message":"Too big"}'), /bedrock: Too big/);
  for (const empty of [[], [{ reasoningContent: {} }], [{ text: " " }]]) {
    assert.throws(() => bedrock.fromResponse(body("max_tokens", empty)), /empty reply \(stop reason max_tokens\)/);
  }
});
