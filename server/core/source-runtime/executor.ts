import type { SearchResult } from "../types/models";
import { executeSourceTransform } from "./runtime";
import type {
  SourceDefinition,
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
import { getUnifiedRequestTimeoutMs } from "../services/timeoutPolicy";
import {
  REDACTED,
  isSensitiveKey,
  redactSensitiveValue,
} from "../utils/redaction";

const DEFAULT_MAX_REQUEST_BODY_BYTES = 64 * 1024;
const RAW_PREVIEW_LIMIT = 100_000;

const text = (value: unknown): string =>
  value == null ? "" : typeof value === "string" ? value : String(value);


interface RenderedRequest {
  url: URL;
  headers: Record<string, string>;
  body?: string;
  method: "GET" | "POST";
}

function requestDebugSnapshot(
  rawUrl: string,
  rendered: RenderedRequest,
) {
  const url = new URL(rawUrl);
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key).map((value) => (
      isSensitiveKey(key) ? REDACTED : value
    ));
    query[key] = values.length > 1 ? values : values[0] || "";
    if (isSensitiveKey(key)) url.searchParams.set(key, REDACTED);
  }
  const headers = Object.fromEntries(Object.entries(rendered.headers).map(([key, value]) => [
    key,
    isSensitiveKey(key) ? REDACTED : value,
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
    body = redactSensitiveValue(body);
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
    /** Receives the completed request trace, including failures. */
    onTrace?: (trace: SourceExecutionTrace) => void;
    /** Template values supplied by the caller, e.g. a validated channel. */
    variables?: Record<string, string | number>;
    /** Additional context exposed to the transform without granting network access. */
    context?: Record<string, unknown>;
    /** Reports synchronous transform + output validation time, including failures. */
    onTransformTiming?: (elapsedMs: number) => void;
  } = {}
): Promise<SourceExecutionResult> {
  const definition = validateSourceDefinition(rawDefinition);
  const request = definition.request;
  const response = definition.response;
  // The persisted system setting is the only timeout source. Callers cannot
  // override it through per-request options or source configuration.
  const requestTimeoutMs = getUnifiedRequestTimeoutMs();
  const baseVariables: Record<string, string | number> = {
    keyword,
    limit: options.limit ?? definition.manifest.maxResults,
    ...(options.variables || {}),
  };
  const allowedVariables = new Set([...RESERVED_VARIABLES, ...Object.keys(options.variables || {})]);

  const runtimeVariables = (): Record<string, string | number> => ({ ...baseVariables });

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
    acceptFor: "json" | "html" | "text"
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

  // ---- Single request and response transform ----
  const fetchRequest = async (
    rendered: RenderedRequest,
    stage: string,
    format: "json" | "html" | "text"
  ): Promise<SafeHttpResponse> => {
    const started = Date.now();
    try {
      const url = rendered.url.toString();
      const attemptStarted = Date.now();
      try {
        const payload = await executeSafeHttp({
          method: rendered.method,
          url,
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
            : [...HTML_CONTENT_TYPES, "text/plain", "text/markdown"],
          allowedDomains: request.allowedDomains,
          allowHttp: request.allowInsecureHttp,
        });
        recordTrace({
          stage,
          url: payload.url.toString(),
          method: rendered.method,
          status: payload.response.status,
          elapsedMs: payload.elapsedMs,
          bytes: payload.bytes,
          contentType: payload.contentType,
          request: requestDebugSnapshot(url, rendered),
        });
        return payload;
      } catch (error) {
        recordTrace({
          stage,
          url,
          method: rendered.method,
          status: null,
          elapsedMs: Date.now() - attemptStarted,
          bytes: 0,
          request: requestDebugSnapshot(url, rendered),
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
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
  const rendered = buildRendered(request, runtimeVariables(), allowedVariables, response.format);
  const payload = await fetchRequest(rendered, "request", response.format);
  const raw = payload.body.slice(0, RAW_PREVIEW_LIMIT);
  const rawTruncated = payload.body.length > RAW_PREVIEW_LIMIT;
  const transformStarted = Date.now();
  try {
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
      keyword,
      url: payload.url.toString(),
      ...(options.context || {}),
    }).slice(0, definition.manifest.maxResults);

    return { results, traces, raw, rawTruncated };
  } finally {
    options.onTransformTiming?.(Date.now() - transformStarted);
  }
}
