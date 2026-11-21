// Mock endpoints served inside Com (no network):
//   mock://slow?seconds=N&body=TEXT  sleep N s, then 200 with TEXT
//   mock://model                     a scripted Anthropic Messages API model
// The model picks its step from the number of assistant messages in the
// request, so it is stateless across Com runs. The script is read per request
// from S3 `mock/script.json` when present, else DEFAULT_SCRIPT.
// MOCK_DELAY_SCALE (default 1) multiplies every delay.

export const MOCK_SCRIPT_KEY = "mock/script.json";

export interface MockStep {
  delay_s: number;
  content: unknown[];
  stop_reason: string;
}

export const DEFAULT_SCRIPT: MockStep[] = [
  {
    delay_s: 60,
    stop_reason: "tool_use",
    content: [
      {
        type: "tool_use",
        id: "toolu_mock_1",
        name: "repl",
        input: {
          code: [
            'globalThis.greet = (n) => "hi " + n;',
            'const r = await fetch("mock://slow?seconds=90&body=slow-ok");',
            'return { greet: greet("there"), slow: await r.text() };',
          ].join("\n"),
        },
      },
    ],
  },
  { delay_s: 5, stop_reason: "end_turn", content: [{ type: "text", text: "Done: the REPL ran and the slow fetch returned." }] },
];

export interface MockDeps {
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** S3 override for the model script, or null. */
  loadScript(): Promise<MockStep[] | null>;
  delayScale: number;
}

export function parseSlow(url: string): { seconds: number; body: string } | null {
  if (!url.startsWith("mock://slow")) return null;
  const q = new URLSearchParams(url.split("?")[1] ?? "");
  const seconds = Number(q.get("seconds") ?? "0");
  return { seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 0, body: q.get("body") ?? "" };
}

/** Which script step answers this request body. */
export function stepIndex(body: string | null): number {
  try {
    const j = JSON.parse(body ?? "{}") as { messages?: { role?: unknown }[] };
    return (j.messages ?? []).filter((m) => m?.role === "assistant").length;
  } catch {
    return 0;
  }
}

function modelName(body: string | null): string {
  try {
    const m = (JSON.parse(body ?? "{}") as { model?: unknown }).model;
    return typeof m === "string" ? m : "mock";
  } catch {
    return "mock";
  }
}

export async function mockRespond(url: string, body: string | null, deps: MockDeps, signal: AbortSignal): Promise<Response> {
  const slow = parseSlow(url);
  if (slow) {
    await deps.sleep(slow.seconds * 1000 * deps.delayScale, signal);
    return new Response(slow.body, { status: 200, headers: { "content-type": "text/plain" } });
  }
  if (url.startsWith("mock://model")) {
    const script = (await deps.loadScript()) ?? DEFAULT_SCRIPT;
    const i = stepIndex(body);
    const step = script[Math.min(i, script.length - 1)];
    if (!step) return new Response("empty mock script", { status: 500 });
    await deps.sleep(step.delay_s * 1000 * deps.delayScale, signal);
    const msg = {
      id: `msg_mock_${i}`,
      type: "message",
      role: "assistant",
      model: modelName(body),
      content: step.content,
      stop_reason: step.stop_reason,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    return new Response(JSON.stringify(msg), { status: 200, headers: { "content-type": "application/json", "request-id": `mock-${i}` } });
  }
  return new Response(`unknown mock URL ${url}`, { status: 404 });
}

/** A sleep that rejects with the signal's reason when aborted. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(signal.reason);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
