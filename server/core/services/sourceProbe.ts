import { type SourceDefinition, type SourceProbe } from "../../../types/source";
import { executeSource } from "../source-runtime/executor";
import type { SourceExecutionTrace } from "../source-runtime/types";
import { validateSourceDefinition } from "../source-runtime/validation";
import { redactSensitiveHeaders } from "../utils/redaction";
import { toSourceDefinition } from "./configuredSource";
import { getConfiguredSource } from "./sourceCatalog";

/** Validate an editor draft without persisting it before an online probe. */
export function prepareSourceForProbe(raw: unknown, sourceId: string): SourceDefinition {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("测试来源配置必须是对象");
  const input = raw as Partial<SourceDefinition>;
  if (String(input.id || "") !== sourceId) throw new Error("测试来源 ID 不匹配");
  if (typeof input.url !== "string" || !input.url.trim()) throw new Error("测试来源地址不能为空");
  if (input.method !== "GET" && input.method !== "POST") throw new Error("测试来源请求方式无效");
  if (input.format !== "html" && input.format !== "json") throw new Error("测试来源响应格式无效");
  if (typeof input.transform !== "string" || !input.transform.trim()) throw new Error("测试来源 transform 不能为空");
  const source: SourceDefinition = {
    id: sourceId,
    name: String(input.name || sourceId).trim().slice(0, 100),
    description: String(input.description || "").trim().slice(0, 500),
    url: input.url.trim(),
    method: input.method,
    format: input.format,
    priority: Number.isInteger(input.priority) ? input.priority : 0,
    enabled: input.enabled !== false,
    request: input.request,
    transform: input.transform,
  };
  validateSourceDefinition(toSourceDefinition(source));
  return source;
}

/** Probe any saved or unsaved resource source with the same one-request runtime used by search. */
export async function probeSourceDefinition(source: SourceDefinition, keyword: string): Promise<SourceProbe> {
  const started = Date.now();
  const result: SourceProbe = { sourceId: source.id, checkedAt: new Date().toISOString(), state: "error", message: "", elapsedMs: 0, httpStatus: null, traces: [], raw: "", rawTruncated: false, results: [] };
  const mapTrace = (trace: SourceExecutionTrace) => ({
    stage: trace.stage,
    url: trace.url,
    method: trace.method,
    status: trace.status,
    elapsedMs: trace.elapsedMs,
    bytes: trace.bytes,
    contentType: trace.contentType || "",
    // The executor already redacts; re-applying the shared rule here keeps the
    // admin-facing probe payload safe even if a future caller builds traces itself.
    ...(trace.request
      ? { request: { ...trace.request, headers: redactSensitiveHeaders(trace.request.headers) } }
      : {}),
    ...(trace.error ? { error: trace.error } : {}),
  });
  try {
    const execution = await executeSource(toSourceDefinition(source), keyword, { limit: 200, onTrace: (trace) => result.traces.push(mapTrace(trace)) });
    result.results = execution.results;
    result.raw = execution.raw;
    result.rawTruncated = execution.rawTruncated;
    result.httpStatus = [...result.traces].reverse().find((trace) => trace.status != null)?.status ?? null;
    result.state = "available";
    result.message = result.results.length ? `解析成功，输出 ${result.results.length} 条统一结果` : "请求成功，本次关键词无有效结果";
  } catch (error) {
    result.httpStatus = [...result.traces].reverse().find((trace) => trace.status != null)?.status ?? null;
    const message = error instanceof Error ? error.message : String(error);
    // A 2xx response means the source request itself completed normally.
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

export async function probeConfiguredSource(id: string, keyword: string): Promise<SourceProbe> {
  const source = getConfiguredSource(id);
  if (!source) throw new Error("Unknown source");
  return probeSourceDefinition(source, keyword);
}
