// Cost report: sums billed GB-seconds from CloudWatch REPORT lines for
// Doorman, Prime and Com, and compares with Prime staying up for the whole
// wall-clock span (spec §1 criterion 3, §8).
//
// Usage (Node >= 22.18, needs AWS credentials):
//   node scripts/cost-report.ts --env rene --since 30m
//   node scripts/cost-report.ts --env rene --start 2026-11-20T10:00Z --end 2026-11-20T11:00Z
//
// Node builtins only; shells out to the `aws` CLI.

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** x86_64, us-west-2 list price. */
export const DEFAULT_PRICE_PER_GB_SECOND = 0.0000166667;
export const DEFAULT_PRICE_PER_REQUEST = 0.2 / 1_000_000;
export const DEFAULT_PRIME_MEMORY_MB = 2048;
export const FUNCTIONS = ["doorman", "prime", "com"] as const;
export type FnName = (typeof FUNCTIONS)[number];

export interface ReportLine {
  requestId: string;
  durationMs: number;
  billedMs: number;
  memoryMb: number;
  maxMemoryMb: number;
  initMs?: number;
  startMs: number;
  endMs: number;
}

const REPORT_RE =
  /^REPORT\s+RequestId:\s*(\S+)\s+Duration:\s*([\d.]+)\s*ms\s+Billed Duration:\s*(\d+)\s*ms\s+Memory Size:\s*(\d+)\s*MB\s+Max Memory Used:\s*(\d+)\s*MB(?:\s+Init Duration:\s*([\d.]+)\s*ms)?/;

/** Parse one CloudWatch log message; non-REPORT lines give null. */
export function parseReport(message: string, timestampMs: number): ReportLine | null {
  const m = REPORT_RE.exec(message.trim());
  if (!m) return null;
  const durationMs = Number(m[2]);
  const initMs = m[6] !== undefined ? Number(m[6]) : undefined;
  const line: ReportLine = {
    requestId: m[1]!,
    durationMs,
    // Billed Duration already includes init (AWS bills init since Aug 2025).
    billedMs: Number(m[3]),
    memoryMb: Number(m[4]),
    maxMemoryMb: Number(m[5]),
    startMs: timestampMs - durationMs - (initMs ?? 0),
    endMs: timestampMs,
  };
  if (initMs !== undefined) line.initMs = initMs;
  return line;
}

export interface SummaryOptions {
  pricePerGbSecond: number;
  pricePerRequest: number;
  primeMemoryMb: number;
}

export interface FnSummary {
  name: FnName;
  invocations: number;
  billedGbSeconds: number;
  cost: number;
}

export interface Summary {
  functions: FnSummary[];
  total: { invocations: number; billedGbSeconds: number; cost: number };
  wallClockMs: number;
  counterfactual: { memoryMb: number; gbSeconds: number; cost: number };
  costRatio: number;
  primeBilledSeconds: number;
  primeUptimeRatio: number;
}

export function summarize(byFn: Record<FnName, ReportLine[]>, opts: SummaryOptions): Summary {
  const functions = FUNCTIONS.map((name): FnSummary => {
    const lines = byFn[name];
    const billedGbSeconds = lines.reduce((s, l) => s + (l.billedMs / 1000) * (l.memoryMb / 1024), 0);
    return {
      name,
      invocations: lines.length,
      billedGbSeconds,
      cost: billedGbSeconds * opts.pricePerGbSecond + lines.length * opts.pricePerRequest,
    };
  });
  const total = functions.reduce(
    (t, f) => ({
      invocations: t.invocations + f.invocations,
      billedGbSeconds: t.billedGbSeconds + f.billedGbSeconds,
      cost: t.cost + f.cost,
    }),
    { invocations: 0, billedGbSeconds: 0, cost: 0 },
  );
  const all = FUNCTIONS.flatMap((n) => byFn[n]);
  const wallClockMs =
    all.length === 0 ? 0 : Math.max(...all.map((l) => l.endMs)) - Math.min(...all.map((l) => l.startMs));
  const prime = byFn.prime;
  const memoryMb = prime.length > 0 ? Math.max(...prime.map((l) => l.memoryMb)) : opts.primeMemoryMb;
  const cfGbSeconds = (wallClockMs / 1000) * (memoryMb / 1024);
  const cfCost = cfGbSeconds * opts.pricePerGbSecond + (prime.length > 0 ? opts.pricePerRequest : 0);
  const primeBilledSeconds = prime.reduce((s, l) => s + l.billedMs, 0) / 1000;
  return {
    functions,
    total,
    wallClockMs,
    counterfactual: { memoryMb, gbSeconds: cfGbSeconds, cost: cfCost },
    costRatio: cfCost > 0 ? total.cost / cfCost : 0,
    primeBilledSeconds,
    primeUptimeRatio: wallClockMs > 0 ? primeBilledSeconds / (wallClockMs / 1000) : 0,
  };
}

export function formatTable(s: Summary, window?: { startMs: number; endMs: number }): string {
  const rows: string[][] = [
    ["function", "invocations", "billed GB-s", "cost USD"],
    ...s.functions.map((f) => [f.name, String(f.invocations), f.billedGbSeconds.toFixed(3), f.cost.toFixed(6)]),
    ["total", String(s.total.invocations), s.total.billedGbSeconds.toFixed(3), s.total.cost.toFixed(6)],
  ];
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  const fmt = (r: string[]) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  const out = [fmt(rows[0]!), widths.map((w) => "-".repeat(w)).join("  "), ...rows.slice(1).map(fmt)];
  out.push("");
  if (window) {
    out.push(`requested window: ${new Date(window.startMs).toISOString()} .. ${new Date(window.endMs).toISOString()}`);
  }
  out.push(`wall clock (activity span): ${(s.wallClockMs / 1000).toFixed(1)} s`);
  out.push(
    `counterfactual (Prime ${s.counterfactual.memoryMb} MB up all wall clock): ` +
      `${s.counterfactual.gbSeconds.toFixed(3)} GB-s, $${s.counterfactual.cost.toFixed(6)}`,
  );
  out.push(`cost ratio (actual / counterfactual): ${s.costRatio.toFixed(4)}`);
  out.push(
    `Prime billed / wall clock: ${s.primeBilledSeconds.toFixed(1)} s / ${(s.wallClockMs / 1000).toFixed(1)} s = ${s.primeUptimeRatio.toFixed(4)}`,
  );
  return out.join("\n");
}

/** "30m", "2h", "90s", "1d" → milliseconds. */
export function parseSince(v: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([smhd])$/.exec(v.trim());
  if (!m) throw new Error(`bad --since value: ${v} (use e.g. 30m, 2h)`);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  return Number(m[1]) * unit;
}

export interface CliOptions {
  env: string;
  startMs: number;
  endMs: number;
  profile?: string;
  /** Unset: the AWS CLI resolves it (AWS_REGION, AWS_DEFAULT_REGION, profile). */
  region?: string;
  logGroupPrefix: string;
  pricePerGbSecond: number;
  help: boolean;
}

export const USAGE = `Usage: node scripts/cost-report.ts --env <name> (--since 30m | --start ISO --end ISO)
  [--profile stz-dev] [--region R (default: AWS_REGION / profile)] [--log-group-prefix /aws/lambda/StzAgent-<env>-]
  [--price-gb-s ${DEFAULT_PRICE_PER_GB_SECOND}]`;

export function parseCli(argv: string[], nowMs = Date.now()): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      env: { type: "string" },
      since: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      profile: { type: "string" },
      region: { type: "string" },
      "log-group-prefix": { type: "string" },
      "price-gb-s": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const help = values.help ?? false;
  const env = values.env ?? "";
  if (!help && !env) throw new Error("--env is required");
  let startMs: number;
  let endMs: number;
  if (values.since) {
    endMs = nowMs;
    startMs = nowMs - parseSince(values.since);
  } else if (values.start && values.end) {
    startMs = Date.parse(values.start);
    endMs = Date.parse(values.end);
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) throw new Error("bad --start/--end date");
  } else if (!help) {
    throw new Error("give --since or both --start and --end");
  } else {
    startMs = endMs = nowMs;
  }
  const price = values["price-gb-s"] !== undefined ? Number(values["price-gb-s"]) : DEFAULT_PRICE_PER_GB_SECOND;
  if (!Number.isFinite(price)) throw new Error("bad --price-gb-s");
  const opts: CliOptions = {
    env,
    startMs,
    endMs,
    logGroupPrefix: values["log-group-prefix"] ?? `/aws/lambda/StzAgent-${env}-`,
    pricePerGbSecond: price,
    help,
  };
  if (values.profile) opts.profile = values.profile;
  if (values.region) opts.region = values.region;
  return opts;
}

/** The `aws` CLI arguments for one log group. No --region unless given. */
export function logsArgs(group: string, o: Pick<CliOptions, "startMs" | "endMs" | "profile" | "region">): string[] {
  const args = ["logs", "filter-log-events", "--log-group-name", group,
    "--start-time", String(o.startMs), "--end-time", String(o.endMs),
    "--filter-pattern", '"REPORT RequestId"', "--output", "json"];
  if (o.region) args.push("--region", o.region);
  if (o.profile) args.push("--profile", o.profile);
  return args;
}

function fetchReports(group: string, o: CliOptions): Promise<ReportLine[]> {
  const args = logsArgs(group, o);
  return new Promise((resolve, reject) => {
    execFile("aws", args, { maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (/ResourceNotFoundException/.test(stderr)) {
          console.warn(`warning: log group ${group} not found; counting zero invocations`);
          resolve([]);
          return;
        }
        reject(new Error(`aws logs filter-log-events failed for ${group}: ${stderr || err.message}`));
        return;
      }
      const data = JSON.parse(stdout) as { events?: { message: string; timestamp: number }[] };
      resolve((data.events ?? []).flatMap((e) => parseReport(e.message, e.timestamp) ?? []));
    });
  });
}

async function main(): Promise<void> {
  let o: CliOptions;
  try {
    o = parseCli(process.argv.slice(2));
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    process.exit(2);
  }
  if (o.help) {
    console.log(USAGE);
    return;
  }
  const lists = await Promise.all(FUNCTIONS.map((fn) => fetchReports(o.logGroupPrefix + fn, o)));
  const byFn = { doorman: lists[0]!, prime: lists[1]!, com: lists[2]! };
  const s = summarize(byFn, {
    pricePerGbSecond: o.pricePerGbSecond,
    pricePerRequest: DEFAULT_PRICE_PER_REQUEST,
    primeMemoryMb: DEFAULT_PRIME_MEMORY_MB,
  });
  console.log(formatTable(s, { startMs: o.startMs, endMs: o.endMs }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
