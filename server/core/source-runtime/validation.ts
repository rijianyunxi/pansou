import { Script } from "node:vm";
import type { SourceDefinition, SourceValue } from "./types";
import { validateOutboundUrl } from "../security/outboundUrl";
import { isForbiddenOutboundHeader } from "../http/safeHttpExecutor";

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
  if ((request.maxResponseBytes ?? 0) > 10 * 1024 * 1024) throw new Error("request.maxResponseBytes 不能超过 10MB");
  if ((request.maxRequestBodyBytes ?? 0) > 256 * 1024) throw new Error("request.maxRequestBodyBytes 不能超过 256KB");
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
