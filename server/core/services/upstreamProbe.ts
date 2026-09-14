import { type UpstreamDefinition, type UpstreamProbe } from "../../../types/source";
import { executeInstructions } from "../instructions/executor";
import { upstreamToInstructionDefinition } from "./configuredUpstreamPlugin";
import { getConfiguredUpstream } from "./upstreamCatalog";
import { probeTgChannel } from "./tg";
import { normalizeSearchResult } from "../utils/searchResultNormalizer";

function requestQuery(rawUrl: string): Record<string, string | string[]> {
  try {
    const url = new URL(rawUrl);
    return Object.fromEntries([...new Set(url.searchParams.keys())].map((key) => {
      const values = url.searchParams.getAll(key);
      return [key, values.length > 1 ? values : values[0] || ""];
    }));
  } catch {
    return {};
  }
}

const SENSITIVE_KEY = /(?:authorization|cookie|token|api[-_]?key|secret|password|passwd|credential|signature)/i;
function safeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [
    key,
    SENSITIVE_KEY.test(key) ? "[REDACTED]" : value,
  ]));
}

/** Probe a saved or unsaved source definition with the same runtime used by search. */
export async function probeUpstreamDefinition(
  source: UpstreamDefinition,
  keyword: string,
): Promise<UpstreamProbe> {
  if (source.sourceKind === "telegram" && source.channel) {
    const tg = await probeTgChannel(source.channel, keyword, 20, {
      fallback: "direct",
      timeoutMs: source.request?.timeoutMs,
      userAgent: source.request?.headers?.["user-agent"],
      headers: source.request?.headers,
      primaryUrl: source.url,
      transform: source.transform,
    });
    return {
      sourceId: source.id,
      checkedAt: tg.checkedAt,
      state: tg.state,
      message: tg.message,
      elapsedMs: tg.elapsedMs,
      httpStatus: tg.httpStatus,
      traces: tg.attempts.map((attempt) => ({
        stage: attempt.route,
        url: attempt.request.url,
        method: attempt.request.method,
        status: attempt.response?.status ?? null,
        elapsedMs: attempt.elapsedMs,
        bytes: attempt.response?.bodyLength ?? 0,
        contentType: attempt.response?.headers?.["content-type"] || "text/html",
        request: {
          url: attempt.request.url,
          query: requestQuery(attempt.request.url),
          headers: safeHeaders(attempt.request.headers),
        },
        ...(attempt.error ? { error: attempt.error } : {}),
      })),
      raw: tg.upstreamResponse?.body || "",
      rawTruncated: tg.upstreamResponse?.bodyTruncated || false,
      results: tg.results.map((item) => normalizeSearchResult(item, false)),
    };
  }

  const started = Date.now();
  const result: UpstreamProbe = {
    sourceId: source.id,
    checkedAt: new Date().toISOString(),
    state: "error",
    message: "",
    elapsedMs: 0,
    httpStatus: null,
    traces: [],
    raw: "",
    rawTruncated: false,
    results: [],
  };
  const mapTrace = (trace: import("../instructions/executor").InstructionExecutionTrace) => ({
    stage: trace.stage,
    url: trace.url,
    method: trace.method,
    status: trace.status,
    elapsedMs: trace.elapsedMs,
    bytes: trace.bytes,
    contentType: trace.contentType || "",
    ...(trace.request ? { request: trace.request } : {}),
    ...(trace.error ? { error: trace.error } : {}),
  });
  try {
    const execution = await executeInstructions(upstreamToInstructionDefinition(source), keyword, {
      limit: 200,
      onTrace: (trace) => { result.traces.push(mapTrace(trace)); },
    });
    result.results = execution.results.map((item) => normalizeSearchResult(item, false));
    const lastResponse = [...result.traces].reverse().find((trace) => trace.status != null);
    result.httpStatus = lastResponse?.status ?? null;
    result.raw = execution.raw;
    result.rawTruncated = execution.rawTruncated;
    result.state = "available";
    result.message = result.results.length
      ? `解析成功，输出 ${result.results.length} 条统一结果`
      : "请求成功，本次关键词无有效结果";
    return result;
  } catch (error) {
    result.message = error instanceof Error ? error.message : String(error);
    const lastResponse = [...result.traces].reverse().find((trace) => trace.status != null);
    result.httpStatus = lastResponse?.status ?? null;
    return result;
  } finally {
    result.elapsedMs = Date.now() - started;
  }
}

/** Probe a configured SQLite catalog entry. */
export async function probeConfiguredUpstream(
  id: string,
  keyword: string,
): Promise<UpstreamProbe> {
  const source = getConfiguredUpstream(id);
  if (!source) throw new Error("Unknown upstream");
  return probeUpstreamDefinition(source, keyword);
}
