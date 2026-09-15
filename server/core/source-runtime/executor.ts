import type { SearchResult } from "../types/models";
import { executeSourceTransform } from "./runtime";
import type {
  SourceDefinition,
  SourceExecutionBudgetOptions,
  SourceExecutionResult,
  SourceExecutionTrace,
  SourceValue,
} from "./types";
import {
  RESERVED_VARIABLES,
  interpolateTemplate,
  validateSourceDefinition,
} from "./validation";
import { executeSafeHttp, type SafeHttpResponse } from "../http/safeHttpExecutor";
import { runWithRetry } from "../utils/retry";
import { getUnifiedRequestTimeoutMs } from "../services/timeoutPolicy";

const DEFAULT_MAX_REQUEST_BODY_BYTES = 64 * 1024;
/** Shared request-attempt budget for the main request and retries. */
const DEFAULT_MAX_TOTAL_REQUESTS = 4;
/** Cumulative request and response payload budget. */
const DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const RAW_PREVIEW_LIMIT = 100_000;

const text = (value: unknown): string =>
  value == null ? "" : typeof value === "string" ? value : String(value);


/** Raised when a per-call budget is exhausted; the message names the budget path. */
export class ExecutionBudgetError extends Error {
  constructor(
    message: string,
    readonly path: "budget.maxTotalRequests" | "budget.maxTotalBytes"
  ) {
    super(message);
    this.name = "ExecutionBudgetError";
  }
}


interface RenderedRequest {
  url: URL;
  headers: Record<string, string>;
  body?: string;
  method: "GET" | "POST";
}

const DEBUG_SENSITIVE_KEY = /(?:authorization|cookie|token|api[-_]?key|secret|password|passwd|credential|signature)/i;

function redactDebugValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactDebugValue(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
    key,
    DEBUG_SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactDebugValue(child),
  ]));
}

function requestDebugSnapshot(
  rawUrl: string,
  rendered: RenderedRequest,
) {
  const url = new URL(rawUrl);
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key).map((value) => (
      DEBUG_SENSITIVE_KEY.test(key) ? "[REDACTED]" : value
    ));
    query[key] = values.length > 1 ? values : values[0] || "";
    if (DEBUG_SENSITIVE_KEY.test(key)) url.searchParams.set(key, "[REDACTED]");
  }
  const headers = Object.fromEntries(Object.entries(rendered.headers).map(([key, value]) => [
    key,
    DEBUG_SENSITIVE_KEY.test(key) ? "[REDACTED]" : value,
  ]));
  let body: unknown = undefined;
  if (rendered.body !== undefined) {
    const contentType = rendered.headers["content-type"] || "";
    try {
      body = contentType.includes("application/json")
        ? JSON.parse(rendered.body)
        : contentType.includes("application/x-www-form-urlencoded")
          ? Object.fromEntries(new URLSearchParams(rendered.body))
          : rendered.body;
    } catch {
      body = rendered.body;
    }
    body = redactDebugValue(body);
  }
  return {
    url: url.toString(),
    query,
    headers,
    ...(body !== undefined ? { body } : {}),
  };
}

const JSON_CONTENT_TYPES = ["application/json", "text/json", "application/*+json"];
const HTML_CONTENT_TYPES = ["text/html", "application/xhtml+xml"];

export async function executeSource(
  rawDefinition: SourceDefinition,
  keyword: string,
  options: {
    signal?: AbortSignal;
    limit?: number;
    /** Per-call resource budget; defaults keep today's worst case admissible. */
    budget?: SourceExecutionBudgetOptions;
    /** Receives each completed request attempt, including failures. */
    onTrace?: (trace: SourceExecutionTrace) => void;
  } = {}
): Promise<SourceExecutionResult> {
  const definition = validateSourceDefinition(rawDefinition);
  const request = definition.request;
  const response = definition.response;
  // The persisted system setting is the only timeout source. Callers cannot
  // override it through per-request options or source manifests.
  const requestTimeoutMs = getUnifiedRequestTimeoutMs();
  const baseVariables = {
    keyword,
    // Legacy template values remain available; automatic pagination is disabled.
    page: 1,
    cursor: "",
    limit: options.limit ?? definition.manifest.maxResults,
  };

  const runtimeVariables = (): Record<string, string | number> => {
    const variables: Record<string, string | number> = { ...baseVariables };
    return variables;
  };

  const buildRendered = (
    spec: {
      method: "GET" | "POST";
      url: string;
      query?: Record<string, SourceValue>;
      headers?: Record<string, string>;
      bodyType?: "json" | "form";
      body?: SourceValue;
    },
    variables: Record<string, string | number>,
    allowedNames: ReadonlySet<string>,
    acceptFor: "json" | "html"
  ): RenderedRequest => {
    const requestUrl = new URL(interpolateTemplate(spec.url, variables, allowedNames) as string);
    const applyQuery = (requestUrl: URL): void => {
      for (const [key, value] of Object.entries(spec.query || {})) {
        requestUrl.searchParams.set(
          key,
          text(interpolateTemplate(value, variables, allowedNames))
        );
      }
    };
    applyQuery(requestUrl);
    const headers: Record<string, string> = {
      accept:
        spec.bodyType === "json" || acceptFor === "json"
          ? "application/json"
          : "text/html",
      ...(spec.headers || {}),
    };
    for (const key of Object.keys(headers)) {
      headers[key] = text(interpolateTemplate(headers[key] ?? "", variables, allowedNames));
    }
    let body: string | undefined;
    if (spec.method === "POST" && spec.body !== undefined) {
      const rendered = interpolateTemplate(spec.body, variables, allowedNames);
      if (spec.bodyType === "form") {
        body = new URLSearchParams(rendered as Record<string, string>).toString();
        headers["content-type"] ||= "application/x-www-form-urlencoded";
      } else {
        body = JSON.stringify(rendered);
        headers["content-type"] ||= "application/json";
      }
    }
    return { url: requestUrl, headers, body, method: spec.method };
  };

  const traces: SourceExecutionTrace[] = [];
  const recordTrace = (trace: SourceExecutionTrace): void => {
    traces.push(trace);
    options.onTrace?.(trace);
  };

  // ---- Per-call budget shared by the main request and retries ----
  const maxRequests = Math.max(
    1,
    Math.floor(options.budget?.maxTotalRequests ?? DEFAULT_MAX_TOTAL_REQUESTS)
  );
  const maxBytes = Math.max(
    1,
    Math.floor(options.budget?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES)
  );
  let requestsUsed = 0;
  let bytesUsed = 0;
  const assertRequestBudget = (): void => {
    if (requestsUsed >= maxRequests) {
      throw new ExecutionBudgetError(
        `解析器请求预算超限: budget.maxTotalRequests=${maxRequests}，本次调用已发起 ${requestsUsed} 个请求`,
        "budget.maxTotalRequests"
      );
    }
  };
  const recordTransfer = (responseBytes: number, requestBody?: string): void => {
    bytesUsed += responseBytes + (requestBody ? Buffer.byteLength(requestBody) : 0);
    if (bytesUsed > maxBytes) {
      throw new ExecutionBudgetError(
        `解析器传输预算超限: budget.maxTotalBytes=${maxBytes}，本次调用已传输 ${bytesUsed} 字节`,
        "budget.maxTotalBytes"
      );
    }
  };

  const fetchRequest = async (
    rendered: RenderedRequest,
    stage: string,
    format: "json" | "html"
  ): Promise<SafeHttpResponse> => {
    const started = Date.now();
    try {
      const url = rendered.url.toString();
      return await runWithRetry(
        url,
        async (attemptUrl) => {
          assertRequestBudget();
          requestsUsed++;
          const attemptStarted = Date.now();
          try {
            const payload = await executeSafeHttp({
              method: rendered.method,
              url: attemptUrl,
              headers: rendered.headers,
              body: rendered.body,
              signal: options.signal,
              timeoutMs: requestTimeoutMs,
              maxRequestBodyBytes:
                request.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES,
              maxResponseBytes: request.maxResponseBytes ?? 2 * 1024 * 1024,
              maxRedirects: 3,
              followRedirects: request.redirect === "follow",
              expectedContentTypes: format === "json"
                ? JSON_CONTENT_TYPES
                : definition.manifest.id.startsWith("tg-")
                  ? [...HTML_CONTENT_TYPES, "text/plain", "text/markdown"]
                  : HTML_CONTENT_TYPES,
              allowedDomains: request.allowedDomains,
              allowHttp: request.allowInsecureHttp,
            });
            recordTransfer(payload.bytes, rendered.body);
            recordTrace({
              stage,
              url: payload.url.toString(),
              method: rendered.method,
              status: payload.response.status,
              elapsedMs: payload.elapsedMs,
              bytes: payload.bytes,
              contentType: payload.contentType,
              request: requestDebugSnapshot(attemptUrl, rendered),
            });
            return payload;
          } catch (error) {
            recordTrace({
              stage,
              url: attemptUrl,
              method: rendered.method,
              status: null,
              elapsedMs: Date.now() - attemptStarted,
              bytes: 0,
              request: requestDebugSnapshot(attemptUrl, rendered),
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        },
        {
          maxRetries: request.retry?.maxRetries,
          delayMs: request.retry?.delayMs,
          signal: options.signal,
        },
      );
    } catch (error) {
      // Preserve the original request timing for callers that display diagnostics.
      if (!traces.some((trace) => trace.stage === stage)) {
        recordTrace({
          stage,
          url: rendered.url.toString(),
          method: rendered.method,
          status: null,
          elapsedMs: Date.now() - started,
          bytes: 0,
          request: requestDebugSnapshot(rendered.url.toString(), rendered),
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  };


  // ---- Single main request and response transform ----
  const rendered = buildRendered(request, runtimeVariables(), RESERVED_VARIABLES, response.format);
  const payload = await fetchRequest(rendered, "request", response.format);
  const raw = payload.body.slice(0, RAW_PREVIEW_LIMIT);
  const rawTruncated = payload.body.length > RAW_PREVIEW_LIMIT;
  const results = executeSourceTransform({
    id: definition.manifest.id,
    version: definition.manifest.version,
    format: response.format,
    // The transform runtime reads the same persisted timeout as the request.
    maxResults: Math.min(Math.max(definition.manifest.maxResults, 1), 500),
    code: response.transform,
  }, payload.body, {
    rawBody: payload.body,
    format: response.format,
    source: definition.manifest.id,
    ...(definition.manifest.id.startsWith("tg-")
      ? { channel: definition.manifest.id.slice(3) }
      : {}),
    keyword,
    url: payload.url.toString(),
    // Compatibility context only; this executor never fetches subsequent pages.
    page: 1,
    route: /(^|\.)r\.jina\.ai$/i.test(payload.url.hostname) ? "jina" : "direct",
  }).slice(0, definition.manifest.maxResults);

  return { results, traces, raw, rawTruncated };
}
