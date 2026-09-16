/**
 * Run a bounded concurrent search load test against a deployed PanHub instance.
 *
 * The default mode uses /api/search/json because it exposes per-source
 * diagnostics (including transformMs). Each round first creates an independent
 * anonymous session and sends that session cookie with the search request.
 *
 * Examples:
 *   pnpm test:stress-search -- --base-url http://127.0.0.1:3000
 *   pnpm test:stress-search -- --base-url http://111.119.233.153:3000 --requests 300 --duration-seconds 180 --concurrency 20
 *
 * Use --mode sse when you want to exercise the browser's streaming endpoint.
 * SSE responses intentionally hide source diagnostics, so JSON mode is the
 * default for a diagnostic load test.
 */

import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const DEFAULT_BASE_URL = "http://111.119.233.153:3000";
const DEFAULT_KEYWORDS = [
  "三体",
  "甄嬛传",
  "庆余年",
  "流浪地球",
  "黑神话悟空",
  "深度学习",
  "Python",
  "红楼梦",
  "诛仙",
  "进击的巨人",
  "哪吒之魔童降世",
  "长安三万里",
  "斗破苍穹",
  "凡人修仙传",
  "庆余年第二季",
  "鬼灭之刃",
];

type Mode = "json" | "sse";
type JsonRecord = Record<string, any>;

type Failure = {
  stage: "session" | "search" | "source-interface" | "transform" | "scheduler";
  status?: number;
  type?: string;
  source?: string;
  message: string;
};

type SourceDiagnostic = {
  id?: string;
  name?: string;
  status?: string;
  resultCount?: number;
  elapsedMs?: number;
  transformMs?: number | null;
  warnings?: JsonRecord[];
};

type RoundReport = {
  round: number;
  keyword: string;
  mode: Mode;
  endpoint: string;
  startedAt: string;
  sessionMs: number | null;
  searchMs: number | null;
  totalMs: number;
  sessionCookie: boolean;
  httpStatus: number | null;
  httpContentType: string | null;
  resultTotal: number | null;
  sourceCount: number;
  successfulSourceCount: number;
  failedSources: JsonRecord[];
  skippedSources: JsonRecord[];
  sourceInterfaceFailures: Failure[];
  transformFailures: Failure[];
  transformMetricsReportedSourceCount: number;
  transformTotalMs: number;
  upstreamElapsedTotalMs: number;
  warnings: JsonRecord[];
  interfaceFailures: Failure[];
  responseBytes: number;
  completed: boolean;
  error?: string;
};

type Options = {
  baseUrl: string;
  requests: number;
  durationSeconds: number;
  concurrency: number;
  mode: Mode;
  timeoutMs: number;
  outputDir: string | null;
  keywords: string[];
};

function numberArg(args: Map<string, string>, name: string, fallback: number): number {
  const raw = args.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number`);
  return Math.floor(value);
}

function parseArgs(argv: string[]): Options {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined || arg === "--") continue;
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const [key, inline] = arg.slice(2).split("=", 2);
    if (!key) throw new Error(`Invalid option: ${arg}`);
    if (inline !== undefined) args.set(key, inline);
    else {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`Missing value for --${key}`);
      args.set(key, next);
      index++;
    }
  }

  const mode = (args.get("mode") || "json") as Mode;
  if (mode !== "json" && mode !== "sse") throw new Error("--mode must be json or sse");
  const requests = numberArg(args, "requests", 300);
  const durationSeconds = numberArg(args, "duration-seconds", 180);
  const concurrency = Math.min(requests, numberArg(args, "concurrency", 20));
  const timeoutMs = numberArg(args, "timeout-ms", Math.min(90_000, durationSeconds * 1000));
  const keywordText = args.get("keywords");
  const keywords = keywordText ? keywordText.split(",").map((item) => item.trim()).filter(Boolean) : DEFAULT_KEYWORDS;
  if (!keywords.length) throw new Error("--keywords must contain at least one keyword");

  return {
    baseUrl: (args.get("base-url") || process.env.PANHUB_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/u, ""),
    requests,
    durationSeconds,
    concurrency,
    mode,
    timeoutMs,
    outputDir: args.get("output") || null,
    keywords,
  };
}

function usage(): void {
  console.log(`Usage: pnpm test:stress-search -- [options]

Options:
  --base-url URL             Target base URL (default: ${DEFAULT_BASE_URL})
  --requests N               Number of search rounds (default: 300)
  --duration-seconds N       Concentrate the test within this window (default: 180)
  --concurrency N            Client worker concurrency (default: 20)
  --mode json|sse            Diagnostic JSON mode or browser-like SSE mode (default: json)
  --timeout-ms N             Per-round hard timeout (default: min(90000, duration))
  --keywords a,b,c           Comma-separated keyword pool
  --output DIR               Report directory (default: .tmp/search-stress-<timestamp>)
`);
}

function nowIso(): string { return new Date().toISOString(); }
function elapsedMs(start: number): number { return Math.round((performance.now() - start) * 100) / 100; }

function responseSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const combined = response.headers.get("set-cookie");
  return combined ? [combined] : [];
}

function extractSessionCookie(response: Response): string | null {
  for (const header of responseSetCookies(response)) {
    const match = header.match(/(?:^|,\s*)panhub_session=([^;,\s]+)/u);
    if (match?.[1]) return `panhub_session=${match[1]}`;
  }
  return null;
}

function failureFromError(stage: Failure["stage"], error: unknown, status?: number): Failure {
  return {
    stage,
    ...(status === undefined ? {} : { status }),
    message: error instanceof Error ? error.message : String(error),
  };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`request timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseBody(response: Response): Promise<string> {
  return await response.text();
}

function parseSseBody(body: string): { completed: boolean; resultTotal: number | null; interfaceFailures: Failure[] } {
  let completed = false;
  let resultTotal: number | null = null;
  const interfaceFailures: Failure[] = [];
  for (const block of body.split(/\n\n+/u)) {
    const event = block.match(/(?:^|\n)event:\s*([^\n]+)/u)?.[1]?.trim();
    const dataText = block.match(/(?:^|\n)data:\s*(.+)/u)?.[1]?.trim();
    if (!event || !dataText) continue;
    try {
      const payload = JSON.parse(dataText) as JsonRecord;
      if (event === "complete") {
        completed = payload.code === 0;
        resultTotal = Number.isFinite(Number(payload.data?.total)) ? Number(payload.data.total) : null;
      } else if (event === "error") {
        interfaceFailures.push({ stage: "search", message: String(payload.message || "SSE error") });
      }
    } catch (error) {
      interfaceFailures.push(failureFromError("search", error));
    }
  }
  if (!completed && !interfaceFailures.length) interfaceFailures.push({ stage: "search", message: "SSE stream ended without a complete event" });
  return { completed, resultTotal, interfaceFailures };
}

function warningsForSource(warnings: JsonRecord[], source: SourceDiagnostic): JsonRecord[] {
  const ids = new Set([source.id, source.name].filter(Boolean));
  return warnings.filter((warning) => warning.source && ids.has(String(warning.source)));
}

function classifySourceFailures(sources: SourceDiagnostic[], warnings: JsonRecord[]): {
  failedSources: JsonRecord[];
  skippedSources: JsonRecord[];
  sourceInterfaceFailures: Failure[];
  transformFailures: Failure[];
} {
  const failedSources: JsonRecord[] = [];
  const skippedSources: JsonRecord[] = [];
  const sourceInterfaceFailures: Failure[] = [];
  const transformFailures: Failure[] = [];
  for (const source of sources) {
    if (source.status !== "failed" && source.status !== "skipped") continue;
    const sourceWarnings = warningsForSource(warnings, source);
    const firstWarning = sourceWarnings[0];
    const detail = {
      id: source.id,
      name: source.name,
      status: source.status,
      elapsedMs: source.elapsedMs ?? 0,
      transformMs: source.transformMs ?? null,
      warnings: sourceWarnings,
    };
    if (source.status === "skipped") {
      skippedSources.push(detail);
      continue;
    }
    failedSources.push(detail);
    const failure: Failure = {
      stage: source.transformMs === null || source.transformMs === undefined ? "source-interface" : "transform",
      ...(firstWarning?.type ? { type: String(firstWarning.type) } : {}),
      ...(source.id ? { source: source.id } : {}),
      message: String(firstWarning?.message || `${source.name || source.id || "source"} ${source.status}`),
    };
    if (failure.stage === "transform") transformFailures.push(failure);
    else sourceInterfaceFailures.push(failure);
  }
  return { failedSources, skippedSources, sourceInterfaceFailures, transformFailures };
}

async function runRound(round: number, options: Options, deadline: number, reportPath: string): Promise<RoundReport> {
  const startedAt = nowIso();
  const roundStarted = performance.now();
  const keyword = options.keywords[(round - 1) % options.keywords.length]!;
  const endpoint = options.mode === "json" ? "/api/search/json" : "/api/search";
  const report: RoundReport = {
    round,
    keyword,
    mode: options.mode,
    endpoint,
    startedAt,
    sessionMs: null,
    searchMs: null,
    totalMs: 0,
    sessionCookie: false,
    httpStatus: null,
    httpContentType: null,
    resultTotal: null,
    sourceCount: 0,
    successfulSourceCount: 0,
    failedSources: [],
    skippedSources: [],
    sourceInterfaceFailures: [],
    transformFailures: [],
    transformMetricsReportedSourceCount: 0,
    transformTotalMs: 0,
    upstreamElapsedTotalMs: 0,
    warnings: [],
    interfaceFailures: [],
    responseBytes: 0,
    completed: false,
  };

  const remaining = () => Math.max(1, Math.min(options.timeoutMs, deadline - performance.now()));
  if (performance.now() >= deadline) {
    report.interfaceFailures.push({ stage: "scheduler", message: "test deadline exceeded before this round started" });
    report.error = "deadline exceeded";
    report.totalMs = elapsedMs(roundStarted);
    appendFileSync(reportPath, `${JSON.stringify(report)}\n`);
    return report;
  }

  try {
    const sessionStarted = performance.now();
    const sessionResponse = await fetchWithTimeout(`${options.baseUrl}/api/account/session`, {
      headers: { Accept: "application/json", "User-Agent": "panhub-search-stress/1.0" },
    }, remaining());
    // Drain the small session response so the HTTP connection can be reused
    // instead of accumulating one undrained response per round.
    await sessionResponse.arrayBuffer();
    report.sessionMs = elapsedMs(sessionStarted);
    const sessionCookie = extractSessionCookie(sessionResponse);
    report.sessionCookie = !!sessionCookie;
    if (!sessionResponse.ok || !sessionCookie) {
      report.interfaceFailures.push({
        stage: "session",
        status: sessionResponse.status,
        message: !sessionResponse.ok ? `session endpoint returned HTTP ${sessionResponse.status}` : "session endpoint did not return panhub_session cookie",
      });
      report.error = report.interfaceFailures.at(-1)?.message;
      report.totalMs = elapsedMs(roundStarted);
      appendFileSync(reportPath, `${JSON.stringify(report)}\n`);
      return report;
    }

    const searchStarted = performance.now();
    const searchUrl = options.mode === "json"
      ? `${options.baseUrl}/api/search/json?kw=${encodeURIComponent(keyword)}&refresh=true`
      : `${options.baseUrl}/api/search`;
    const searchResponse = await fetchWithTimeout(searchUrl, {
      method: options.mode === "json" ? "GET" : "POST",
      headers: {
        Accept: options.mode === "json" ? "application/json" : "text/event-stream",
        ...(options.mode === "json" ? {} : { "Content-Type": "application/json" }),
        Cookie: sessionCookie,
        "User-Agent": "panhub-search-stress/1.0",
      },
      ...(options.mode === "json" ? {} : { body: JSON.stringify({ kw: keyword, refresh: true }) }),
    }, remaining());
    const body = await readResponseBody(searchResponse);
    report.searchMs = elapsedMs(searchStarted);
    report.httpStatus = searchResponse.status;
    report.httpContentType = searchResponse.headers.get("content-type");
    report.responseBytes = Buffer.byteLength(body, "utf8");

    if (!searchResponse.ok) {
      report.interfaceFailures.push({ stage: "search", status: searchResponse.status, message: `search endpoint returned HTTP ${searchResponse.status}: ${body.slice(0, 500)}` });
      report.error = report.interfaceFailures.at(-1)?.message;
      report.totalMs = elapsedMs(roundStarted);
      appendFileSync(reportPath, `${JSON.stringify(report)}\n`);
      return report;
    }

    if (options.mode === "sse") {
      const parsed = parseSseBody(body);
      report.completed = parsed.completed;
      report.resultTotal = parsed.resultTotal;
      report.interfaceFailures.push(...parsed.interfaceFailures);
      if (report.interfaceFailures.length) report.error = report.interfaceFailures[0]?.message;
      report.totalMs = elapsedMs(roundStarted);
      appendFileSync(reportPath, `${JSON.stringify(report)}\n`);
      return report;
    }

    let payload: JsonRecord;
    try {
      payload = JSON.parse(body) as JsonRecord;
    } catch (error) {
      report.interfaceFailures.push(failureFromError("search", error, searchResponse.status));
      report.error = report.interfaceFailures.at(-1)?.message;
      report.totalMs = elapsedMs(roundStarted);
      appendFileSync(reportPath, `${JSON.stringify(report)}\n`);
      return report;
    }

    if (payload.code !== 0 || !payload.data || typeof payload.data !== "object") {
      report.interfaceFailures.push({ stage: "search", status: searchResponse.status, message: String(payload.message || "search API returned an invalid payload") });
      report.error = report.interfaceFailures.at(-1)?.message;
      report.totalMs = elapsedMs(roundStarted);
      appendFileSync(reportPath, `${JSON.stringify(report)}\n`);
      return report;
    }

    const data = payload.data as JsonRecord;
    const sources = Array.isArray(data.meta?.sources) ? data.meta.sources as SourceDiagnostic[] : [];
    const warnings = Array.isArray(data.meta?.warnings) ? data.meta.warnings as JsonRecord[] : [];
    const classified = classifySourceFailures(sources, warnings);
    report.completed = true;
    report.resultTotal = Number.isFinite(Number(data.total)) ? Number(data.total) : null;
    report.sourceCount = sources.length;
    report.successfulSourceCount = sources.filter((source) => source.status === "success").length;
    report.failedSources = classified.failedSources;
    report.skippedSources = classified.skippedSources;
    report.sourceInterfaceFailures = classified.sourceInterfaceFailures;
    report.transformFailures = classified.transformFailures;
    report.transformMetricsReportedSourceCount = sources.filter((source) => typeof source.transformMs === "number").length;
    report.transformTotalMs = sources.reduce((sum, source) => sum + (typeof source.transformMs === "number" ? source.transformMs : 0), 0);
    report.upstreamElapsedTotalMs = sources.reduce((sum, source) => sum + (typeof source.elapsedMs === "number" ? source.elapsedMs : 0), 0);
    report.warnings = warnings;
    if (warnings.some((warning) => !warning.source)) {
      report.interfaceFailures.push(...warnings.filter((warning) => !warning.source).map((warning) => ({
        stage: "search" as const,
        ...(warning.type ? { type: String(warning.type) } : {}),
        message: String(warning.message || "search warning"),
      })));
    }
    if (report.interfaceFailures.length) report.error = report.interfaceFailures[0]?.message;
  } catch (error) {
    report.interfaceFailures.push(failureFromError("search", error));
    report.error = report.interfaceFailures.at(-1)?.message;
  }

  report.totalMs = elapsedMs(roundStarted);
  appendFileSync(reportPath, `${JSON.stringify(report)}\n`);
  return report;
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? null;
}

function distribution(values: number[]): JsonRecord {
  return values.length ? {
    count: values.length,
    minMs: Math.min(...values),
    avgMs: Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: Math.max(...values),
    totalMs: Math.round(values.reduce((sum, value) => sum + value, 0) * 100) / 100,
  } : { count: 0 };
}

function aggregateFailures(reports: RoundReport[], field: "sourceInterfaceFailures" | "transformFailures"): JsonRecord[] {
  const counts = new Map<string, JsonRecord>();
  for (const report of reports) {
    for (const failure of report[field]) {
      const key = `${failure.source || "global"}:${failure.type || "unknown"}:${failure.message}`;
      const current = counts.get(key) || { source: failure.source || null, type: failure.type || null, message: failure.message, count: 0, rounds: [] as number[] };
      current.count++;
      current.rounds.push(report.round);
      counts.set(key, current);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

function compactFailureCount(report: RoundReport): string {
  return `sourceFail=${report.failedSources.length} skipped=${report.skippedSources.length} sourceIface=${report.sourceInterfaceFailures.length} transform=${report.transformFailures.length} transformReported=${report.transformMetricsReportedSourceCount}`;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date();
  const outputDir = options.outputDir || join(".tmp", `search-stress-${startedAt.toISOString().replace(/[:.]/gu, "-")}`);
  mkdirSync(outputDir, { recursive: true });
  const reportPath = join(outputDir, "rounds.jsonl");
  const summaryPath = join(outputDir, "summary.json");
  writeFileSync(reportPath, "");

  console.log(`Target: ${options.baseUrl}`);
  console.log(`Mode: ${options.mode}; rounds: ${options.requests}; client concurrency: ${options.concurrency}; deadline: ${options.durationSeconds}s`);
  console.log(`Reports: ${reportPath}`);

  const deadline = performance.now() + options.durationSeconds * 1000;
  const reports: RoundReport[] = [];
  let nextRound = 1;
  const worker = async (): Promise<void> => {
    while (true) {
      const round = nextRound++;
      if (round > options.requests) return;
      const report = await runRound(round, options, deadline, reportPath);
      reports.push(report);
      const status = !report.completed || report.interfaceFailures.length > 0 ? "FAIL" : report.failedSources.length > 0 || report.skippedSources.length > 0 ? "PARTIAL" : "OK";
      console.log(`[${String(round).padStart(String(options.requests).length, "0")}/${options.requests}] ${status} ${report.keyword} ${report.totalMs.toFixed(0)}ms results=${report.resultTotal ?? "-"} transformTotal=${report.transformTotalMs}ms ${compactFailureCount(report)}`);
    }
  };
  await Promise.all(Array.from({ length: options.concurrency }, () => worker()));

  const totalElapsedMs = Math.round((Date.now() - startedAt.getTime()) * 100) / 100;
  reports.sort((a, b) => a.round - b.round);
  const completed = reports.filter((report) => report.completed);
  const successful = completed.filter((report) => report.interfaceFailures.length === 0);
  const searchTimes = reports.map((report) => report.searchMs).filter((value): value is number => value !== null);
  const roundTimes = reports.map((report) => report.totalMs);
  const transformTimes = reports.filter((report) => report.completed).map((report) => report.transformTotalMs);
  const statusCounts = reports.reduce<Record<string, number>>((counts, report) => {
    const key = report.httpStatus === null ? "no-response" : String(report.httpStatus);
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  const summary = {
    generatedAt: nowIso(),
    target: options.baseUrl,
    endpoint: options.mode === "json" ? "/api/search/json?kw=...&refresh=true" : "/api/search",
    mode: options.mode,
    requestedRounds: options.requests,
    observedRounds: reports.length,
    durationLimitMs: options.durationSeconds * 1000,
    actualWallClockMs: totalElapsedMs,
    clientConcurrency: options.concurrency,
    perRoundTimeoutMs: options.timeoutMs,
    eachRoundCreatesFreshCookie: true,
    statusCounts,
    roundsCompleted: completed.length,
    roundsSuccessful: successful.length,
    roundsFailed: reports.length - successful.length,
    roundsWithSourceFailures: reports.filter((report) => report.failedSources.length > 0).length,
    roundsWithCircuitSkips: reports.filter((report) => report.skippedSources.length > 0).length,
    roundsWithWarnings: reports.filter((report) => report.warnings.length > 0).length,
    sessionCookieSuccess: reports.filter((report) => report.sessionCookie).length,
    responseBytes: reports.reduce((sum, report) => sum + report.responseBytes, 0),
    roundLatency: distribution(roundTimes),
    searchLatency: distribution(searchTimes),
    transformTotalLatencyPerRound: distribution(transformTimes),
    transformTotalMsAcrossRounds: reports.reduce((sum, report) => sum + report.transformTotalMs, 0),
    transformMetricsReportedSourceCount: reports.reduce((sum, report) => sum + report.transformMetricsReportedSourceCount, 0),
    upstreamElapsedMsAcrossRounds: reports.reduce((sum, report) => sum + report.upstreamElapsedTotalMs, 0),
    totalResults: reports.reduce((sum, report) => sum + (report.resultTotal || 0), 0),
    sourceInterfaceFailures: aggregateFailures(reports, "sourceInterfaceFailures"),
    transformFailures: aggregateFailures(reports, "transformFailures"),
    skippedSourceCounts: [...reports.reduce((counts, report) => {
      for (const source of report.skippedSources) {
        const key = String(source.id || source.name || "unknown");
        const current = counts.get(key) || { source: key, count: 0, rounds: [] as number[] };
        current.count++;
        current.rounds.push(report.round);
        counts.set(key, current);
      }
      return counts;
    }, new Map<string, JsonRecord>()).values()].sort((a, b) => b.count - a.count),
    failedSourceCounts: [...reports.reduce((counts, report) => {
      for (const source of report.failedSources) {
        const key = String(source.id || source.name || "unknown");
        const current = counts.get(key) || { source: key, count: 0, rounds: [] as number[] };
        current.count++;
        current.rounds.push(report.round);
        counts.set(key, current);
      }
      return counts;
    }, new Map<string, JsonRecord>()).values()].sort((a, b) => b.count - a.count),
    interfaceFailures: reports.flatMap((report) => report.interfaceFailures.map((failure) => ({ round: report.round, ...failure }))),
    output: { roundsJsonl: reportPath, summaryJson: summaryPath },
  };
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log("\nSUMMARY");
  console.log(JSON.stringify({
    actualWallClockMs: totalElapsedMs,
    rounds: reports.length,
    completed: completed.length,
    successful: successful.length,
    partial: completed.filter((report) => (report.failedSources.length > 0 || report.skippedSources.length > 0) && report.interfaceFailures.length === 0).length,
    failed: reports.length - successful.length,
    roundsWithSourceFailures: reports.filter((report) => report.failedSources.length > 0).length,
    roundsWithCircuitSkips: reports.filter((report) => report.skippedSources.length > 0).length,
    statusCounts,
    roundLatency: summary.roundLatency,
    searchLatency: summary.searchLatency,
    transformTotalLatencyPerRound: summary.transformTotalLatencyPerRound,
    transformTotalMsAcrossRounds: summary.transformTotalMsAcrossRounds,
    transformMetricsReportedSourceCount: summary.transformMetricsReportedSourceCount,
    sourceInterfaceFailures: summary.sourceInterfaceFailures,
    transformFailures: summary.transformFailures,
    failedSourceCounts: summary.failedSourceCounts,
    skippedSourceCounts: summary.skippedSourceCounts,
    interfaceFailures: summary.interfaceFailures.slice(0, 20),
  }, null, 2));
  console.log(`\nReports written to ${outputDir}`);

  if (reports.length !== options.requests || totalElapsedMs > options.durationSeconds * 1000 + 1000) process.exitCode = 2;
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : error);
  usage();
  process.exitCode = 1;
}
