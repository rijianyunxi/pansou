import { Script } from "node:vm";
import type { SourceDefinition, SourceValue } from "./types";
import { validateOutboundUrl } from "../security/outboundUrl";
import { isForbiddenOutboundHeader } from "../security/outboundHeaders";

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor", "eval", "function", "script"]);
export const RESERVED_VARIABLES = new Set(["keyword", "limit"]);
const DEFAULT_ALLOWED_VARIABLES = RESERVED_VARIABLES;
const VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,31}$/;

const TEMPLATE_PATTERN = /{{\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)\s*}}/g;

export function interpolateTemplate(
  value: SourceValue,
  variables: Record<string, string | number>,
  allowedNames: ReadonlySet<string> = DEFAULT_ALLOWED_VARIABLES
): SourceValue {
  if (typeof value === "string") {
    return value.replace(TEMPLATE_PATTERN, (_match, key: string) => {
      if (!allowedNames.has(key)) throw new Error(`不支持的模板变量: {{${key}}}`);
      return String(variables[key] ?? "");
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolateTemplate(item, variables, allowedNames));
  if (value && typeof value === "object") {
    const out: Record<string, SourceValue> = {};
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) throw new Error(`禁止的配置字段: ${key}`);
      out[key] = interpolateTemplate(child, variables, allowedNames);
    }
    return out;
  }
  return value;
}

const MAX_SOURCE_REQUEST_URL_LENGTH = 4_096;
const MAX_SOURCE_REQUEST_DEPTH = 8;
const MAX_SOURCE_REQUEST_KEYS = 100;
const MAX_SOURCE_REQUEST_ARRAY_ITEMS = 100;
const MAX_SOURCE_REQUEST_STRING_LENGTH = 8_192;
const MAX_SOURCE_REQUEST_TOTAL_BYTES = 256 * 1024;
const MAX_SOURCE_REQUEST_HEADERS = 50;
const MAX_SOURCE_REQUEST_HEADER_NAME_LENGTH = 128;
const MAX_SOURCE_REQUEST_HEADER_VALUE_LENGTH = 8_192;
const MAX_SOURCE_REQUEST_DOMAINS = 50;
const MAX_SOURCE_REQUEST_DOMAIN_LENGTH = 253;

interface RequestComplexityState {
  bytes: number;
  seen: WeakSet<object>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function addRequestBytes(state: RequestComplexityState, value: string, path: string): void {
  state.bytes += new TextEncoder().encode(value).byteLength;
  if (state.bytes > MAX_SOURCE_REQUEST_TOTAL_BYTES) {
    throw new Error(`${path} 序列化后不能超过 ${MAX_SOURCE_REQUEST_TOTAL_BYTES} bytes`);
  }
}

function validateSourceValueComplexity(
  value: unknown,
  path: string,
  depth: number,
  state: RequestComplexityState,
): void {
  if (depth > MAX_SOURCE_REQUEST_DEPTH) throw new Error(`${path} 嵌套层级不能超过 ${MAX_SOURCE_REQUEST_DEPTH}`);
  if (value === null) {
    addRequestBytes(state, "null", path);
    return;
  }
  if (typeof value === "string") {
    if ([...value].length > MAX_SOURCE_REQUEST_STRING_LENGTH) {
      throw new Error(`${path} 字符串长度不能超过 ${MAX_SOURCE_REQUEST_STRING_LENGTH}`);
    }
    addRequestBytes(state, value, path);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} 必须是有限数字`);
    addRequestBytes(state, String(value), path);
    return;
  }
  if (typeof value === "boolean") {
    addRequestBytes(state, value ? "true" : "false", path);
    return;
  }
  if (typeof value !== "object") throw new Error(`${path} 只能包含 JSON 值`);
  if (state.seen.has(value)) throw new Error(`${path} 不能包含循环引用`);
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_SOURCE_REQUEST_ARRAY_ITEMS) {
        throw new Error(`${path} 数组元素不能超过 ${MAX_SOURCE_REQUEST_ARRAY_ITEMS}`);
      }
      for (const [index, child] of value.entries()) {
        validateSourceValueComplexity(child, `${path}[${index}]`, depth + 1, state);
      }
      return;
    }
    if (!isPlainRecord(value)) throw new Error(`${path} 只能是普通对象`);
    const entries = Object.entries(value);
    if (entries.length > MAX_SOURCE_REQUEST_KEYS) {
      throw new Error(`${path} 字段不能超过 ${MAX_SOURCE_REQUEST_KEYS} 个`);
    }
    for (const [key, child] of entries) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) throw new Error(`${path}.${key} 不允许使用`);
      if ([...key].length > MAX_SOURCE_REQUEST_STRING_LENGTH) {
        throw new Error(`${path}.${key} 字段名过长`);
      }
      addRequestBytes(state, key, `${path}.${key}`);
      validateSourceValueComplexity(child, `${path}.${key}`, depth + 1, state);
    }
  } finally {
    state.seen.delete(value);
  }
}

function validateFiniteInteger(value: unknown, path: string, min: number, max: number): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${path} 必须是 ${min} 到 ${max} 的整数`);
  }
}

/** Validate the declarative request separately so templates and persisted sources share the same limits. */
export function validateSourceRequestConfig(input: unknown): void {
  if (!isPlainRecord(input)) throw new Error("request 必须是普通对象");
  const request = input;
  if (typeof request.url !== "string" || !request.url.trim() || [...request.url].length > MAX_SOURCE_REQUEST_URL_LENGTH) {
    throw new Error(`request.url 必须是 1 到 ${MAX_SOURCE_REQUEST_URL_LENGTH} 个字符的字符串`);
  }
  if (request.method !== "GET" && request.method !== "POST") throw new Error("request.method 必须是 GET 或 POST");
  if (request.bodyType !== undefined && request.bodyType !== "json" && request.bodyType !== "form") {
    throw new Error("request.bodyType 必须是 json 或 form");
  }
  if (request.redirect !== undefined && request.redirect !== "error" && request.redirect !== "follow") {
    throw new Error("request.redirect 必须是 error 或 follow");
  }
  if (request.allowInsecureHttp !== undefined && typeof request.allowInsecureHttp !== "boolean") {
    throw new Error("request.allowInsecureHttp 必须是布尔值");
  }
  validateFiniteInteger(request.maxResponseBytes, "request.maxResponseBytes", 1, 10 * 1024 * 1024);
  validateFiniteInteger(request.maxRequestBodyBytes, "request.maxRequestBodyBytes", 1, 256 * 1024);

  const state: RequestComplexityState = { bytes: 0, seen: new WeakSet() };
  if (request.query !== undefined) {
    if (!isPlainRecord(request.query)) throw new Error("request.query 必须是普通对象");
    validateSourceValueComplexity(request.query, "request.query", 0, state);
  }
  if (request.body !== undefined) validateSourceValueComplexity(request.body, "request.body", 0, state);

  if (request.headers !== undefined) {
    if (!isPlainRecord(request.headers)) throw new Error("request.headers 必须是普通对象");
    const headers = request.headers;
    const entries = Object.entries(headers);
    if (entries.length > MAX_SOURCE_REQUEST_HEADERS) throw new Error(`request.headers 不能超过 ${MAX_SOURCE_REQUEST_HEADERS} 个`);
    for (const [name, value] of entries) {
      if ([...name].length > MAX_SOURCE_REQUEST_HEADER_NAME_LENGTH) throw new Error(`request.headers.${name} 名称过长`);
      if (isForbiddenOutboundHeader(name)) throw new Error(`request.headers.${name} 不允许设置`);
      if (typeof value !== "string" || [...value].length > MAX_SOURCE_REQUEST_HEADER_VALUE_LENGTH) {
        throw new Error(`request.headers.${name} 必须是长度不超过 ${MAX_SOURCE_REQUEST_HEADER_VALUE_LENGTH} 的字符串`);
      }
      addRequestBytes(state, name, `request.headers.${name}`);
      addRequestBytes(state, value, `request.headers.${name}`);
    }
  }

  if (request.allowedDomains !== undefined) {
    if (!Array.isArray(request.allowedDomains) || request.allowedDomains.length > MAX_SOURCE_REQUEST_DOMAINS) {
      throw new Error(`request.allowedDomains 必须是最多 ${MAX_SOURCE_REQUEST_DOMAINS} 项的字符串数组`);
    }
    for (const domain of request.allowedDomains) {
      if (typeof domain !== "string" || !domain.trim() || [...domain].length > MAX_SOURCE_REQUEST_DOMAIN_LENGTH) {
        throw new Error(`request.allowedDomains 中包含无效域名`);
      }
      addRequestBytes(state, domain, "request.allowedDomains");
    }
  }
}

function assertNoForbiddenKeys(value: unknown, path = "definition"): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) throw new Error(`${path}.${key} 不允许使用`);
    if (typeof child === "function") throw new Error(`${path}.${key} 不允许函数`);
    assertNoForbiddenKeys(child, `${path}.${key}`);
  }
}

export function validateSourceDefinition(input: unknown): SourceDefinition {
  assertNoForbiddenKeys(input);
  const definition = input as Partial<SourceDefinition>;
  if (definition.schemaVersion !== 1) throw new Error("仅支持 schemaVersion: 1");
  const manifest = definition.manifest;
  if (!manifest?.id || !manifest.name || !manifest.version || manifest.kind !== "source") {
    throw new Error("manifest 必须包含 id、name、version，且 kind 必须为 source");
  }
  if (!Number.isInteger(manifest.maxResults) || manifest.maxResults < 1 || manifest.maxResults > 1000) {
    throw new Error("manifest.maxResults 必须是 1 到 1000 的整数");
  }
  const request = definition.request;
  if (!request || !["GET", "POST"].includes(request.method) || !request.url) {
    throw new Error("request.method 和 request.url 是必填项");
  }
  validateSourceRequestConfig(request);
  const urlOptions = {
    allowedDomains: request.allowedDomains,
    allowHttp: request.allowInsecureHttp,
  };
  validateOutboundUrl(request.url, urlOptions);
  for (const name of Object.keys(request.headers || {})) {
    if (isForbiddenOutboundHeader(name)) {
      throw new Error(`request.headers.${name} 不允许设置`);
    }
  }
  const response = definition.response;
  if (!response || !["json", "html", "text"].includes(response.format)) {
    throw new Error("response.format 必须是 json、html 或 text");
  }
  if (typeof response.transform !== "string" || !response.transform.trim()) {
    throw new Error("response.transform 必须是返回统一资源结果数组的字符串");
  }
  return structuredClone(definition as SourceDefinition);
}

const MAX_CODE = 100_000;

function transformFunctionSource(code: string): string {
  const trimmed = code.trim();
  if (/^(?:async\s+)?function\b/.test(trimmed) || trimmed.includes("=>")) return `(${trimmed})`;
  return `(function(payload, $, context) {\n${trimmed}\n})`;
}

function validateTransformSyntax(code: string): void {
  try {
    new Script(transformFunctionSource(code), { filename: "transform:validation" });
  } catch (error) {
    throw new Error(`解析函数代码语法错误：${error instanceof Error ? error.message : String(error)}`);
  }
}

export function validateSourceTransformCode(code: unknown): string {
  if (typeof code !== "string" || !code.trim()) throw new Error("transform 不能为空");
  if (code.length > MAX_CODE) throw new Error(`transform 不能超过 ${MAX_CODE} 个字符`);
  if (/\b(?:require|process|globalThis|Function|eval|import|constructor)\b/.test(code)) {
    throw new Error("transform 包含禁止的运行时关键字");
  }
  validateTransformSyntax(code);
  return code;
}
