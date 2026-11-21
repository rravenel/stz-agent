// End-to-end check of one turn on a deployed stack (issue #0008, owner run #0023):
// POST /wake, POST /messages, then follow GET /events until the turn ends and
// check that Prime slept while Com held a request and Com woke it again.
//
// Usage (Node >= 22.18; STZ_API_TOKEN exported, never printed):
//   node scripts/e2e.ts --env rene [--outputs cdk.out/outputs-rene.json] [--text "..."] [--timeout 600]
//
// Node builtins only.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export interface Ev {
  seq: number;
  ts: string;
  run: string;
  kind: string;
  msg_id?: string;
  corr_id?: string;
  body?: unknown;
}

export interface Check {
  name: string;
  pass: boolean;
  seq: number | null;
  detail: string;
}

export interface TurnResult {
  checks: Check[];
  pass: boolean;
  info: { runs: number; wallClockMs: number | null; sleepToWakeMs: number | null };
}

const body = (e: Ev) => (e.body ?? {}) as Record<string, unknown>;
const lifecycle = (e: Ev, name: string) => e.kind === "lifecycle" && body(e)["event"] === name;
const t = (e: Ev) => Date.parse(e.ts);

/** The model.response that ends a turn. */
export const isTurnEnd = (e: Ev) => e.kind === "model.response" && body(e)["stop"] === "end_turn";

/** Pure: judge one turn's events (sorted or not) for our msg_id. */
export function checkTurn(events: Ev[], msgId: string): TurnResult {
  const evs = [...events].sort((a, b) => a.seq - b.seq);
  const user = evs.find((e) => e.kind === "user.message" && e.msg_id === msgId);
  const after = (s: number | undefined) => evs.filter((e) => s !== undefined && e.seq > s);
  const idle = after(user?.seq).find((e) => lifecycle(e, "exit_idle") && Number(body(e)["pending_requests"]) >= 1);
  const wake = after(idle?.seq).find((e) => lifecycle(e, "start") && body(e)["reason"] === "wake" && e.run !== idle?.run);
  const end = after(wake?.seq).find(isTurnEnd);
  const c = (name: string, e: Ev | undefined, ok: string, missing: string): Check => ({
    name,
    pass: e !== undefined,
    seq: e?.seq ?? null,
    detail: e ? ok : missing,
  });
  const checks = [
    c("a user.message", user, `msg_id ${msgId}`, `no user.message with msg_id ${msgId}`),
    c("b exit_idle pending>=1", idle, `pending_requests ${idle ? body(idle)["pending_requests"] : ""}`, "Prime never slept while Com held a request"),
    c("c start reason=wake", wake, `new run ${wake?.run ?? ""}`, "no later run started with reason wake"),
    c("d final model.response", end, "stop end_turn", "no end_turn model.response after the wake"),
  ];
  const first = evs.find((e) => e.seq >= (user?.seq ?? Infinity)) ?? user;
  const last = end ?? evs[evs.length - 1];
  return {
    checks,
    pass: checks.every((x) => x.pass),
    info: {
      runs: new Set(evs.filter((e) => user && e.seq >= user.seq).map((e) => e.run)).size,
      wallClockMs: first && last ? t(last) - t(first) : null,
      sleepToWakeMs: idle && wake ? t(wake) - t(idle) : null,
    },
  };
}

export function formatTimeline(events: Ev[]): string {
  return events
    .map((e) => {
      const b = body(e);
      const what = e.kind === "lifecycle" ? String(b["event"] ?? "") : (e.corr_id ?? e.msg_id ?? (typeof b["stop"] === "string" ? b["stop"] : ""));
      return `${String(e.seq).padStart(5)}  ${e.ts}  ${e.run.slice(0, 8).padEnd(8)}  ${e.kind.padEnd(14)}  ${what}`;
    })
    .join("\n");
}

export function formatChecks(r: TurnResult): string {
  const lines = r.checks.map((c) => `${c.pass ? "PASS" : "FAIL"}  ${c.name.padEnd(24)}  seq ${c.seq ?? "-"}  ${c.detail}`);
  const s = (ms: number | null) => (ms === null ? "-" : `${(ms / 1000).toFixed(1)} s`);
  lines.push(`info  runs ${r.info.runs}, wall clock ${s(r.info.wallClockMs)}, exit_idle → wake ${s(r.info.sleepToWakeMs)}`);
  lines.push(r.pass ? "E2E PASS" : "E2E FAIL");
  return lines.join("\n");
}

export interface CliOptions {
  env: string;
  outputs: string;
  text: string;
  timeoutS: number;
  help: boolean;
}

export const USAGE = `Usage: node scripts/e2e.ts --env <name> [--outputs cdk.out/outputs-<env>.json] [--text "..."] [--timeout 600]
  Needs STZ_API_TOKEN (the Doorman bearer token).`;

export const DEFAULT_TEXT = "Fetch https://example.com and tell me its title.";

export function parseCli(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      env: { type: "string" },
      outputs: { type: "string" },
      text: { type: "string" },
      timeout: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const help = values.help ?? false;
  const env = values.env ?? "";
  if (!help && !env) throw new Error("--env is required");
  const timeoutS = values.timeout !== undefined ? Number(values.timeout) : 600;
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) throw new Error("bad --timeout");
  return { env, outputs: values.outputs ?? `cdk.out/outputs-${env}.json`, text: values.text ?? DEFAULT_TEXT, timeoutS, help };
}

/** ApiUrl from the file `cdk deploy --outputs-file` writes (scripts/deploy.sh). */
export function apiUrlFromOutputs(json: string, env: string): string {
  const o = JSON.parse(json) as Record<string, Record<string, string> | undefined>;
  const url = o[`StzAgent-${env}`]?.["ApiUrl"];
  if (!url) throw new Error(`no ApiUrl for StzAgent-${env} in outputs`);
  return url.replace(/\/+$/, "");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(base: string, token: string, method: string, path: string, payload?: unknown) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const text = await r.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { status: r.status, json };
}

async function main(): Promise<number> {
  const o = parseCli(process.argv.slice(2));
  if (o.help) {
    console.log(USAGE);
    return 0;
  }
  const token = process.env["STZ_API_TOKEN"];
  if (!token) throw new Error("STZ_API_TOKEN is not set");
  const base = apiUrlFromOutputs(readFileSync(o.outputs, "utf8"), o.env);
  const deadline = Date.now() + o.timeoutS * 1000;

  // Start of the log before our turn, so the timeline shows only this run.
  let after = -1;
  for (;;) {
    const r = await call(base, token, "GET", `/events?after=${after}&limit=500`);
    if (r.status !== 200) throw new Error(`GET /events → ${r.status}`);
    const p = r.json as { next_after: number; more: boolean };
    after = p.next_after;
    if (!p.more) break;
  }
  const start = after;

  const w = await call(base, token, "POST", "/wake");
  console.log(`POST /wake → ${w.status} ${JSON.stringify(w.json)}`);

  const msg_id = randomUUID();
  let posted = false;
  for (let i = 0; i < 5 && !posted; i++) {
    const r = await call(base, token, "POST", "/messages", { msg_id, text: o.text });
    console.log(`POST /messages (try ${i + 1}) → ${r.status}`);
    posted = r.status === 202;
    if (!posted) await sleep(2000);
  }
  if (!posted) throw new Error("Doorman never got Prime's ack after 5 tries");

  const events: Ev[] = [];
  let ended = false;
  while (!ended && Date.now() < deadline) {
    const r = await call(base, token, "GET", `/events?after=${after}&limit=500`);
    if (r.status === 200) {
      const p = r.json as { events: Ev[]; next_after: number; more: boolean };
      events.push(...p.events);
      after = p.next_after;
      ended = checkTurn(events, msg_id).checks[3]!.pass;
      if (p.more) continue;
    } else {
      console.log(`GET /events → ${r.status}, retrying`);
    }
    if (!ended) await sleep(2000);
  }
  if (!ended) console.log(`timed out after ${o.timeoutS} s`);

  console.log(`\ntimeline (events after seq ${start}):`);
  console.log(formatTimeline(events));
  const result = checkTurn(events, msg_id);
  console.log("");
  console.log(formatChecks(result));
  return result.pass ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      console.error(USAGE);
      process.exit(2);
    },
  );
}
