import { type UpstreamDefinition, type UpstreamProbe } from "../../../types/source";
import { executeSource } from "../source-runtime/executor";
import type { SourceExecutionTrace } from "../source-runtime/types";
import { upstreamToSourceDefinition } from "./configuredSource";
import { getConfiguredUpstream } from "./upstreamCatalog";
import { getUnifiedRequestTimeoutMs } from "./timeoutPolicy";

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

/** Probe any saved or unsaved resource source with the same one-request runtime used by search. */
export async function probeUpstreamDefinition(source: UpstreamDefinition, keyword: string): Promise<UpstreamProbe> {
  const started = Date.now();
  const result: UpstreamProbe = { sourceId: source.id, checkedAt: new Date().toISOString(), state: "error", message: "", elapsedMs: 0, httpStatus: null, traces: [], raw: "", rawTruncated: false, results: [] };
  const mapTrace = (trace: SourceExecutionTrace) => ({ stage: trace.stage, url: trace.url, method: trace.method, status: trace.status, elapsedMs: trace.elapsedMs, bytes: trace.bytes, contentType: trace.contentType || "", ...(trace.request ? { request: trace.request } : {}), ...(trace.error ? { error: trace.error } : {}) });
  try {
    const execution = await executeSource(upstreamToSourceDefinition(source), keyword, { limit: 200, onTrace: (trace) => result.traces.push(mapTrace(trace)) });
    result.results = execution.results;
    result.raw = execution.raw;
    result.rawTruncated = execution.rawTruncated;
    result.httpStatus = [...result.traces].reverse().find((trace) => trace.status != null)?.status ?? null;
    result.state = "available";
    result.message = result.results.length ? `解析成功，输出 ${result.results.length} 条统一结果` : "请求成功，本次关键词无有效结果";
  } catch (error) {
    result.httpStatus = [...result.traces].reverse().find((trace) => trace.status != null)?.status ?? null;
    const message = error instanceof Error ? error.message : String(error);
    // A 2xx response means the upstream request itself completed normally.
    // Some providers return a business-level rejection (for example, a
    // keyword restriction) in a 200 response; that is a diagnostic warning,
    // not a transport/source availability error.
    if (result.httpStatus != null && result.httpStatus >= 200 && result.httpStatus < 300) {
      result.state = "warning";
      result.message = `HTTP ${result.httpStatus} 已正常返回，但来源未产生可用结果：${message}`;
    } else {
      result.message = message;
    }
  } finally { result.elapsedMs = Date.now() - started; }
  return result;
}

export async function probeConfiguredUpstream(id: string, keyword: string): Promise<UpstreamProbe> {
  const source = getConfiguredUpstream(id);
  if (!source) throw new Error("Unknown source");
  return probeUpstreamDefinition(source, keyword);
}
