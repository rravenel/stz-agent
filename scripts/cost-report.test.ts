import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTable, logsArgs, parseCli, parseReport, parseSince, summarize, type ReportLine } from "./cost-report.ts";

const OPTS = { pricePerGbSecond: 0.0000166667, pricePerRequest: 0.2 / 1_000_000, primeMemoryMb: 2048 };

test("parseReport: cold start with Init Duration", () => {
  const msg =
    "REPORT RequestId: 3f1c-aa\tDuration: 1500.25 ms\tBilled Duration: 1750 ms\tMemory Size: 2048 MB\tMax Memory Used: 180 MB\tInit Duration: 249.10 ms\t\n";
  const r = parseReport(msg, 10_000);
  assert.ok(r);
  assert.equal(r.requestId, "3f1c-aa");
  assert.equal(r.billedMs, 1750);
  assert.equal(r.memoryMb, 2048);
  assert.equal(r.maxMemoryMb, 180);
  assert.equal(r.initMs, 249.1);
  assert.equal(r.endMs, 10_000);
  assert.ok(Math.abs(r.startMs - (10_000 - 1500.25 - 249.1)) < 1e-9);
});

test("parseReport: warm start without Init Duration, spaces", () => {
  const r = parseReport("REPORT RequestId: abc Duration: 12.3 ms Billed Duration: 13 ms Memory Size: 128 MB Max Memory Used: 70 MB", 500);
  assert.ok(r);
  assert.equal(r.initMs, undefined);
  assert.equal(r.billedMs, 13);
  assert.ok(Math.abs(r.startMs - 487.7) < 1e-9);
});

test("parseReport: XRAY suffix ignored", () => {
  const r = parseReport(
    "REPORT RequestId: x1\tDuration: 2.0 ms\tBilled Duration: 3 ms\tMemory Size: 256 MB\tMax Memory Used: 60 MB\t\nXRAY TraceId: 1-abc\tSegmentId: def\tSampled: true",
    100,
  );
  assert.ok(r);
  assert.equal(r.memoryMb, 256);
});

test("parseReport: non-REPORT lines give null", () => {
  assert.equal(parseReport("START RequestId: x Version: $LATEST", 0), null);
  assert.equal(parseReport("END RequestId: x", 0), null);
  assert.equal(parseReport("hello REPORT RequestId: x", 0), null);
});

function line(startMs: number, billedMs: number, memoryMb: number): ReportLine {
  return { requestId: "r", durationMs: billedMs, billedMs, memoryMb, maxMemoryMb: 1, startMs, endMs: startMs + billedMs };
}

test("summarize: GB-s, counterfactual and ratio", () => {
  const byFn = {
    doorman: [],
    prime: [line(0, 2000, 2048), line(40_000, 2000, 2048), line(98_000, 2000, 2048)],
    com: [line(5_000, 90_000, 128)],
  };
  const s = summarize(byFn, OPTS);
  const prime = s.functions.find((f) => f.name === "prime")!;
  const com = s.functions.find((f) => f.name === "com")!;
  assert.equal(prime.invocations, 3);
  assert.equal(prime.billedGbSeconds.toFixed(6), "12.000000");
  assert.equal(com.billedGbSeconds.toFixed(6), "11.250000");
  assert.equal(s.total.billedGbSeconds.toFixed(6), "23.250000");
  assert.equal(s.wallClockMs, 100_000);
  assert.equal(s.counterfactual.memoryMb, 2048);
  assert.equal(s.counterfactual.gbSeconds.toFixed(6), "200.000000");
  const expectedTotal = 23.25 * OPTS.pricePerGbSecond + 4 * OPTS.pricePerRequest;
  const expectedCf = 200 * OPTS.pricePerGbSecond + OPTS.pricePerRequest;
  assert.equal(s.total.cost.toFixed(9), expectedTotal.toFixed(9));
  assert.equal(s.costRatio.toFixed(6), (expectedTotal / expectedCf).toFixed(6));
  assert.equal(s.primeUptimeRatio.toFixed(6), "0.060000");
});

test("summarize: no lines gives zeros and default Prime memory", () => {
  const s = summarize({ doorman: [], prime: [], com: [] }, OPTS);
  assert.equal(s.wallClockMs, 0);
  assert.equal(s.counterfactual.memoryMb, 2048);
  assert.equal(s.costRatio, 0);
});

test("parseSince and parseCli window", () => {
  assert.equal(parseSince("30m"), 1_800_000);
  assert.equal(parseSince("2h"), 7_200_000);
  assert.throws(() => parseSince("30"));
  const o = parseCli(["--env", "rene", "--since", "30m"], 10_000_000);
  assert.equal(o.endMs - o.startMs, 1_800_000);
  assert.equal(o.logGroupPrefix, "/aws/lambda/StzAgent-rene-");
  const o2 = parseCli(["--env", "x", "--start", "2026-11-20T10:00:00Z", "--end", "2026-11-20T11:00:00Z"]);
  assert.equal(o2.endMs - o2.startMs, 3_600_000);
  assert.throws(() => parseCli(["--since", "5m"]));
  assert.throws(() => parseCli(["--env", "x"]));
});

test("formatTable: rows for each function and totals", () => {
  const s = summarize({ doorman: [line(0, 100, 256)], prime: [line(0, 1000, 2048)], com: [] }, OPTS);
  const t = formatTable(s, { startMs: 0, endMs: 60_000 });
  for (const w of ["doorman", "prime", "com", "total", "counterfactual", "cost ratio", "requested window"]) {
    assert.match(t, new RegExp(w));
  }
});

test("region: omitted unless --region is given; --profile passed through", () => {
  const o = parseCli(["--env", "x", "--since", "5m", "--profile", "stz-dev"], 1_000_000);
  assert.equal(o.region, undefined);
  const a = logsArgs("/aws/lambda/g", o);
  assert.ok(!a.includes("--region"));
  assert.deepEqual(a.slice(-2), ["--profile", "stz-dev"]);
  const e = logsArgs("/aws/lambda/g", parseCli(["--env", "x", "--since", "5m", "--region", "eu-west-1"], 1_000_000));
  const i = e.indexOf("--region");
  assert.deepEqual(e.slice(i, i + 2), ["--region", "eu-west-1"]);
  assert.ok(!e.includes("--profile"));
});
