import { load, type CheerioAPI } from "cheerio";
import type { SearchResult } from "../types/models";
import { parseWithParserPlugin } from "../parsers/runtime";
import type { ParserPluginRecord } from "../parsers/types";
import type {
  InstructionField,
  InstructionFieldRegex,
  InstructionPluginDefinition,
  InstructionStageRequest,
  InstructionValue,
} from "./types";
import {
  MAX_TOTAL_REQUESTS,
  RESERVED_VARIABLES,
  assertStageScope,
  interpolateTemplate,
  validateInstructionDefinition,
} from "./validator";
import { executeSafeHttp, type SafeHttpResponse } from "../http/safeHttpExecutor";
import { runWithRetry } from "../utils/retry";
import { readMappingPath } from "../../../utils/upstreamAdapter";

const DEFAULT_MAX_REQUEST_BODY_BYTES = 64 * 1024;
/** Worst case today: MAX_STAGES(2) pre-stages + main request + pagination up
 * to MAX_TOTAL_REQUESTS(6) counted requests = 7 HTTP calls per invocation. */
const DEFAULT_MAX_TOTAL_REQUESTS = MAX_TOTAL_REQUESTS + 1;
/** ~7 requests x the 2 MiB default per-response cap, rounded up. */
const DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_PAGES = 10;
const DEFAULT_MAX_PAGES = 3;
const MAX_REGEX_SUBJECT_CHARS = 10_000;
const RAW_PREVIEW_LIMIT = 100_000;
const MAX_STAGE_VAR_LENGTH = 512;

const text = (value: unknown): string =>
  value == null ? "" : typeof value === "string" ? value : String(value);

const regexCache = new Map<string, RegExp>();

function compileRegex(spec: InstructionFieldRegex, path: string): RegExp {
  const key = `${spec.flags ?? ""}\u0000${spec.pattern}`;
  const cached = regexCache.get(key);
  if (cached) return cached;
  let compiled: RegExp;
  try {
    compiled = new RegExp(spec.pattern, spec.flags ?? "");
  } catch (error) {
    throw new Error(
      `${path}.regex.pattern 无效: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (regexCache.size >= 500) regexCache.clear();
  regexCache.set(key, compiled);
  return compiled;
}

function applyRegex(
  value: string,
  spec: InstructionFieldRegex | undefined,
  path: string
): string {
  if (!spec) return value;
  const subject =
    value.length > MAX_REGEX_SUBJECT_CHARS
      ? value.slice(0, MAX_REGEX_SUBJECT_CHARS)
      : value;
  const match = compileRegex(spec, path).exec(subject);
  if (!match) return "";
  const group = spec.group ?? (match.length > 1 ? 1 : 0);
  return match[group] ?? "";
}

function finishField(result: string, spec: InstructionField): unknown {
  if (spec.transform === "number") return Number(result);
  if (spec.transform === "boolean") return Boolean(result);
  if (spec.prefix) result = spec.prefix + result;
  if (spec.suffix) result += spec.suffix;
  return result;
}

function fieldValue(
  item: unknown,
  field: InstructionField | string | undefined,
  path: string
): unknown {
  if (field == null) return "";
  const spec: InstructionField =
    typeof field === "string" ? { path: field } : field;
  let value: unknown;
  if (spec.source === "constant") value = spec.value;
  else if (spec.path) value = readMappingPath(item, spec.path);
  else value = spec.value;
  if ((value == null || value === "") && spec.default !== undefined) {
    value = spec.default;
  }
  if (spec.regex) {
    return finishField(applyRegex(text(value), spec.regex, path), spec);
  }
  if (spec.transform === "number") return Number(value);
  if (spec.transform === "boolean") return Boolean(value);
  let result = text(value);
  if (spec.prefix) result = spec.prefix + result;
  if (spec.suffix) result += spec.suffix;
  return result;
}

export interface InstructionExecutionTrace {
  stage: string;
  url: string;
  method: string;
  status: number | null;
  elapsedMs: number;
  bytes: number;
  contentType?: string;
  request?: {
    url: string;
    query: Record<string, string | string[]>;
    headers: Record<string, string>;
    body?: unknown;
  };
  error?: string;
}

export interface InstructionExecutionResult {
  results: SearchResult[];
  traces: InstructionExecutionTrace[];
  /** Admin-only debug payload preview. */
  raw: string;
  rawTruncated: boolean;
}

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

export interface ExecutionBudgetOptions {
  /** Total HTTP requests per call; stages, main request and pagination share it. */
  maxTotalRequests?: number;
  /** Cumulative request + response payload bytes per call. */
  maxTotalBytes?: number;
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

/** Stage-extracted values must be safe to interpolate into URLs and headers. */
function sanitizeStageVar(value: unknown, path: string): string {
  const textValue = text(value).trim();
  if (!textValue) throw new Error(`${path} 提取结果为空`);
  if (textValue.length > MAX_STAGE_VAR_LENGTH) {
    throw new Error(`${path} 提取结果超过 ${MAX_STAGE_VAR_LENGTH} 字符`);
  }
  if (/[\s\u0000-\u001f\u007f]/.test(textValue)) {
    throw new Error(`${path} 提取结果包含空白或控制字符`);
  }
  return textValue;
}

const JSON_CONTENT_TYPES = ["application/json", "text/json", "application/*+json"];
const HTML_CONTENT_TYPES = ["text/html", "application/xhtml+xml"];

export async function executeInstructions(
  rawDefinition: InstructionPluginDefinition,
  keyword: string,
  options: {
    signal?: AbortSignal;
    page?: number;
    cursor?: string;
    limit?: number;
    /** Per-call resource budget; defaults keep today's worst case admissible. */
    budget?: ExecutionBudgetOptions;
    /** Receives each completed request attempt, including failures. */
    onTrace?: (trace: InstructionExecutionTrace) => void;
  } = {}
): Promise<InstructionExecutionResult> {
  const definition = validateInstructionDefinition(rawDefinition);
  const request = definition.request;
  const response = definition.response;
  const nextPage = response.nextPage;
  const transformRecord: ParserPluginRecord = {
    id: definition.manifest.id,
    status: "published",
    publishedVersion: definition.manifest.version,
    manifest: {
      id: definition.manifest.id,
      name: definition.manifest.name,
      version: definition.manifest.version,
      format: response.format,
      target: "upstream",
      timeoutMs: Math.min(Math.max(definition.manifest.timeoutMs, 100), 5000),
      maxResults: Math.min(Math.max(definition.manifest.maxResults, 1), 500),
    },
    code: response.transform,
    versions: [],
    createdAt: "",
    updatedAt: "",
    updatedBy: "system",
  };
  const stages = request.stages ?? [];
  const maxPages = nextPage
    ? Math.min(Math.max(nextPage.maxPages ?? DEFAULT_MAX_PAGES, 1), MAX_PAGES)
    : 1;
  const baseVariables = {
    keyword,
    page: options.page ?? 1,
    cursor: options.cursor ?? "",
    limit: options.limit ?? definition.manifest.maxResults,
  };

  const runtimeVariables = (
    stageVars: Record<string, string>,
    page: number
  ): Record<string, string | number> => {
    const variables: Record<string, string | number> = { ...baseVariables, page, ...stageVars };
    return variables;
  };

  const buildRendered = (
    spec: {
      method: "GET" | "POST";
      url: string;
      query?: Record<string, InstructionValue>;
      headers?: Record<string, string>;
      bodyType?: "json" | "form";
      body?: InstructionValue;
    },
    variables: Record<string, string | number>,
    allowedNames: ReadonlySet<string>,
    acceptFor: "json" | "html",
    nextPageParam?: { name: string; page: number }
  ): RenderedRequest => {
    const requestUrl = new URL(interpolateTemplate(spec.url, variables, allowedNames) as string);
    const applyQuery = (requestUrl: URL): void => {
      for (const [key, value] of Object.entries(spec.query || {})) {
        requestUrl.searchParams.set(
          key,
          text(interpolateTemplate(value, variables, allowedNames))
        );
      }
      if (nextPageParam) {
        requestUrl.searchParams.set(nextPageParam.name, String(nextPageParam.page));
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

  const traces: InstructionExecutionTrace[] = [];
  const recordTrace = (trace: InstructionExecutionTrace): void => {
    traces.push(trace);
    options.onTrace?.(trace);
  };
  const results: SearchResult[] = [];
  const visited = new Set<string>();

  // ---- Per-call budgets shared by every stage, the main request and pagination ----
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

  const fetchPage = async (
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
              timeoutMs: request.timeoutMs ?? definition.manifest.timeoutMs,
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
      // Preserve the original stage timing for callers that display diagnostics.
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

  const findNextPageUrl = ($: CheerioAPI, baseUrl: URL): URL | null => {
    const selector = nextPage?.selector;
    if (!selector) return null;
    const node = $(selector).first();
    if (!node.length) return null;
    const raw =
      (
        node.attr("href") ||
        node.find("a[href]").first().attr("href") ||
        ""
      ).trim() || "";
    if (!raw || raw.startsWith("#")) return null;
    try {
      return new URL(raw, baseUrl);
    } catch {
      return null;
    }
  };

  const extractStageVarValues = (
    stage: InstructionStageRequest,
    body: string,
    index: number,
    sink: Record<string, string>
  ): void => {
    const prefix = `stages[${index}].response.vars`;
    let parsed: unknown = null;
    let $: CheerioAPI | null = null;
    if (stage.response.format === "json") {
      try {
        parsed = JSON.parse(body);
      } catch (error) {
        throw new Error(
          `${prefix} 所在响应 JSON 解析失败: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    } else {
      $ = load(body);
    }
    for (const [name, spec] of Object.entries(stage.response.vars)) {
      const pathLabel = `${prefix}.${name}`;
      const fieldSpec: InstructionField =
        typeof spec === "string"
          ? stage.response.format === "json"
            ? { path: spec }
            : { selector: spec }
          : spec;
      let raw: unknown;
      if (fieldSpec.source === "constant") {
        raw = fieldSpec.value;
      } else if (stage.response.format === "json") {
        raw = fieldValue(parsed, fieldSpec, pathLabel);
      } else {
        const node = fieldSpec.selector ? $!(fieldSpec.selector).first() : null;
        if (!node || !node.length) {
          raw = fieldSpec.default ?? "";
        } else {
          raw =
            fieldSpec.source === "html"
              ? node.html()
              : fieldSpec.source === "href"
                ? node.attr("href")
                : fieldSpec.source === "attr"
                  ? node.attr(fieldSpec.attribute || "")
                  : node.text();
          if ((raw == null || raw === "") && fieldSpec.default !== undefined) {
            raw = fieldSpec.default;
          }
        }
      }
      if (fieldSpec.regex) raw = applyRegex(text(raw), fieldSpec.regex, pathLabel);
      sink[name] = sanitizeStageVar(raw, pathLabel);
    }
  };

  // ---- Pre-main stages: token/buildId pre-fetch, sequentially scoped ----
  const stageVars: Record<string, string> = {};
  const allStageVarNames = new Set<string>();
  for (const stage of stages) {
    for (const name of Object.keys(stage.response.vars)) allStageVarNames.add(name);
  }
  const allNames = new Set([...RESERVED_VARIABLES, ...allStageVarNames]);
  const placeholderStageVars: Record<string, string> = {};
  for (const name of allStageVarNames) placeholderStageVars[name] = "";
  let scopeUrl: URL | null = null;
  try {
    scopeUrl = new URL(
      interpolateTemplate(request.url, runtimeVariables(placeholderStageVars, baseVariables.page), allNames) as string
    );
  } catch {
    scopeUrl = null;
  }
  for (let index = 0; index < stages.length; index++) {
    const stage = stages[index];
    if (!stage) break;
    // Stage i may reference variables extracted by stages before it only.
    const allowed = new Set([...RESERVED_VARIABLES, ...Object.keys(stageVars)]);
    const rendered = buildRendered(
      { ...stage, method: stage.method ?? "GET" },
      runtimeVariables(stageVars, baseVariables.page),
      allowed,
      stage.response.format
    );
    assertStageScope(rendered.url, scopeUrl, request.allowedDomains);
    const stagePayload = await fetchPage(rendered, `stage:${index + 1}`, stage.response.format);
    // Stage failures are fatal: the main request cannot be built without them.
    extractStageVarValues(stage, stagePayload.body, index, stageVars);
  }
  let totalRequests = stages.length;

  // ---- Main request ----
  const first = buildRendered(
    request,
    runtimeVariables(stageVars, 1),
    allNames,
    response.format,
    nextPage?.queryParam ? { name: nextPage.queryParam, page: 1 } : undefined
  );
  visited.add(first.url.toString());
  const payload = await fetchPage(first, "request", response.format);
  const raw = payload.body.slice(0, RAW_PREVIEW_LIMIT);
  const rawTruncated = payload.body.length > RAW_PREVIEW_LIMIT;

  let lastPayload = payload;
  let lastDom: CheerioAPI | null = null;
  const appendPayloadResults = (pagePayload: SafeHttpResponse, page: number): number => {
    if (response.format === "html") lastDom = load(pagePayload.body);
    const parsed = parseWithParserPlugin(transformRecord, pagePayload.body, {
      rawBody: pagePayload.body,
      format: response.format,
      source: definition.manifest.id,
      ...(definition.manifest.id.startsWith("tg-")
        ? { channel: definition.manifest.id.slice(3) }
        : {}),
      keyword,
      url: pagePayload.url.toString(),
      page,
      route: /(^|\.)r\.jina\.ai$/i.test(pagePayload.url.hostname) ? "jina" : "direct",
    });
    const before = results.length;
    results.push(...parsed.slice(0, Math.max(0, definition.manifest.maxResults - results.length)));
    return results.length - before;
  };
  appendPayloadResults(payload, 1);

  for (
    let page = 2;
    page <= maxPages &&
    results.length < definition.manifest.maxResults &&
    totalRequests < MAX_TOTAL_REQUESTS;
    page++
  ) {
    let next: RenderedRequest | null = null;
    if (nextPage?.selector && lastDom) {
      const target = findNextPageUrl(lastDom, lastPayload.url);
      if (target) {
        // A next-page href is followed with a plain GET regardless of the
        // original POST method; the body template no longer applies.
        const headers = { ...first.headers };
        delete headers["content-type"];
        next = { url: target, headers, method: "GET" };
      }
    } else if (nextPage?.queryParam) {
      next = buildRendered(
        request,
        runtimeVariables(stageVars, page),
        allNames,
        response.format,
        { name: nextPage.queryParam, page }
      );
    }
    if (!next) break;
    const nextKey = next.url.toString();
    if (visited.has(nextKey)) break;
    visited.add(nextKey);
    totalRequests++;

    let pagePayload: SafeHttpResponse;
    try {
      pagePayload = await fetchPage(next, `page:${page}`, response.format);
    } catch (error) {
      // Later-page failures degrade to the accumulated earlier-page results,
      // but budget exhaustion must surface as a search-layer warning.
      if (error instanceof ExecutionBudgetError) throw error;
      break;
    }
    lastPayload = pagePayload;
    try {
      const appended = appendPayloadResults(pagePayload, page);
      if (response.format === "json" && appended === 0) break;
    } catch (error) {
      recordTrace({
        stage: `page:${page}`,
        url: pagePayload.url.toString(),
        method: next.method,
        status: pagePayload.response.status,
        elapsedMs: 0,
        bytes: pagePayload.bytes,
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }

  return { results, traces, raw, rawTruncated };
}
