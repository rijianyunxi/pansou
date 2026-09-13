import type { InstructionField, InstructionPluginDefinition, InstructionStageRequest, InstructionValue } from "./types";
import { validateOutboundUrl } from "../security/outboundUrl";
import { isForbiddenOutboundHeader } from "../http/safeHttpExecutor";

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor", "eval", "function", "script"]);
export const RESERVED_VARIABLES = new Set(["keyword", "page", "cursor", "limit"]);
const DEFAULT_ALLOWED_VARIABLES = RESERVED_VARIABLES;
const VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,31}$/;
export const MAX_STAGES = 2;
export const MAX_TOTAL_REQUESTS = 6;
const MAX_STAGE_VARS = 8;
const MAX_SECRETS = 8;

const TEMPLATE_PATTERN = /{{\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)\s*}}/g;

export function interpolateTemplate(
  value: InstructionValue,
  variables: Record<string, string | number>,
  allowedNames: ReadonlySet<string> = DEFAULT_ALLOWED_VARIABLES
): InstructionValue {
  if (typeof value === "string") {
    return value.replace(TEMPLATE_PATTERN, (_match, key: string) => {
      if (!allowedNames.has(key)) throw new Error(`不支持的模板变量: {{${key}}}`);
      return String(variables[key] ?? "");
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolateTemplate(item, variables, allowedNames));
  if (value && typeof value === "object") {
    const out: Record<string, InstructionValue> = {};
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) throw new Error(`禁止的配置字段: ${key}`);
      out[key] = interpolateTemplate(child, variables, allowedNames);
    }
    return out;
  }
  return value;
}

function collectReferencedVariables(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(TEMPLATE_PATTERN)) found.add(match[1]!);
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectReferencedVariables(item, found));
    return found;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) collectReferencedVariables(child, found);
  }
  return found;
}

function assertNoForbiddenKeys(value: unknown, path = "definition"): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) throw new Error(`${path}.${key} 不允许使用`);
    if (typeof child === "function") throw new Error(`${path}.${key} 不允许函数`);
    assertNoForbiddenKeys(child, `${path}.${key}`);
  }
}

function validateTemplates(value: unknown, allowedNames: ReadonlySet<string>): void {
  // interpolateTemplate performs the single source of truth validation for
  // template variables without evaluating any expression.
  interpolateTemplate(value as InstructionValue, {}, allowedNames);
}

function validateFieldRegex(spec: InstructionField, path: string): void {
  const regex = spec.regex;
  if (!regex) return;
  if (typeof regex.pattern !== "string" || regex.pattern.length < 1 || regex.pattern.length > 200) {
    throw new Error(`${path}.regex.pattern 必须是 1 到 200 个字符的字符串`);
  }
  if (regex.flags !== undefined && (typeof regex.flags !== "string" || !/^[imsu]*$/.test(regex.flags))) {
    throw new Error(`${path}.regex.flags 仅允许 i、m、s、u`);
  }
  if (regex.group !== undefined && (!Number.isInteger(regex.group) || regex.group < 0 || regex.group > 10)) {
    throw new Error(`${path}.regex.group 必须是 0 到 10 的整数`);
  }
  try {
    new RegExp(regex.pattern, regex.flags ?? "");
  } catch (error) {
    throw new Error(
      `${path}.regex.pattern 无效: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function validateFieldSpec(field: unknown, path: string): void {
  if (field == null || typeof field === "string") return;
  if (typeof field !== "object" || Array.isArray(field)) {
    throw new Error(`${path} 必须是字符串或对象`);
  }
  validateFieldRegex(field as InstructionField, path);
}

function validateResponseInstructions(response: InstructionPluginDefinition["response"]): void {
  for (const key of ["title", "content", "datetime", "messageId", "uniqueId"] as const) {
    if (response.fields?.[key] !== undefined) validateFieldSpec(response.fields[key], `response.fields.${key}`);
  }
  for (const key of ["url", "type", "password"] as const) {
    if (response.links?.[key] !== undefined) validateFieldSpec(response.links[key], `response.links.${key}`);
  }
  const nextPage = response.nextPage;
  if (!nextPage) return;
  if (nextPage.selector !== undefined && typeof nextPage.selector !== "string") {
    throw new Error("response.nextPage.selector 必须是字符串");
  }
  if (nextPage.queryParam !== undefined && (typeof nextPage.queryParam !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(nextPage.queryParam))) {
    throw new Error("response.nextPage.queryParam 必须是 1 到 32 位字母、数字、下划线或连字符");
  }
  const hasSelector = typeof nextPage.selector === "string" && nextPage.selector.trim().length > 0;
  const hasQueryParam = typeof nextPage.queryParam === "string" && nextPage.queryParam.length > 0;
  if (!hasSelector && !hasQueryParam) {
    throw new Error("response.nextPage 需要 selector 或 queryParam");
  }
  if (hasSelector && response.format !== "html") {
    throw new Error("response.nextPage.selector 仅支持 HTML 响应");
  }
  if (nextPage.maxPages !== undefined && (!Number.isInteger(nextPage.maxPages) || nextPage.maxPages < 1 || nextPage.maxPages > 10)) {
    throw new Error("response.nextPage.maxPages 必须是 1 到 10 的整数");
  }
}

function validateSecretNames(request: InstructionPluginDefinition["request"]): Set<string> {
  const names = new Set<string>();
  const secrets = request.secrets;
  if (secrets === undefined) return names;
  if (!Array.isArray(secrets) || secrets.length > MAX_SECRETS) {
    throw new Error(`request.secrets 必须是最多 ${MAX_SECRETS} 个密钥名的数组`);
  }
  for (const name of secrets) {
    if (typeof name !== "string" || !VARIABLE_NAME_PATTERN.test(name)) {
      throw new Error(`request.secrets 密钥名不合法: ${String(name)}`);
    }
    names.add(`secret.${name}`);
  }
  return names;
}

function rejectSecretsInUrlOrQuery(
  url: string,
  query: Record<string, InstructionValue> | undefined,
  secretNames: ReadonlySet<string>,
  path: string
): void {
  const referenced = collectReferencedVariables({ url, query });
  for (const name of referenced) {
    if (secretNames.has(name)) {
      throw new Error(`${path} 不允许引用密钥（密钥仅可用于请求头和请求体）`);
    }
  }
}

function validateStage(
  stage: InstructionStageRequest,
  index: number,
  allowedSoFar: ReadonlySet<string>,
  secretNames: ReadonlySet<string>,
  urlOptions: { allowedDomains?: string[]; allowHttp?: boolean }
): Set<string> {
  const path = `request.stages[${index}]`;
  if (!stage || typeof stage !== "object") throw new Error(`${path} 必须是对象`);
  const method = stage.method ?? "GET";
  if (!["GET", "POST"].includes(method)) throw new Error(`${path}.method 仅支持 GET/POST`);
  if (!stage.url || typeof stage.url !== "string") throw new Error(`${path}.url 必填`);
  validateOutboundUrl(stage.url, urlOptions);
  rejectSecretsInUrlOrQuery(stage.url, stage.query, secretNames, `${path}.url`);
  validateTemplates({ url: stage.url, query: stage.query, headers: stage.headers, body: stage.body }, allowedSoFar);
  for (const name of Object.keys(stage.headers || {})) {
    if (isForbiddenOutboundHeader(name)) throw new Error(`${path}.headers.${name} 不允许设置`);
  }
  if (stage.timeoutMs !== undefined && (!Number.isInteger(stage.timeoutMs) || stage.timeoutMs < 1000 || stage.timeoutMs > 120000)) {
    throw new Error(`${path}.timeoutMs 必须是 1000 到 120000 的整数`);
  }
  if ((stage.maxResponseBytes ?? 0) > 10 * 1024 * 1024) throw new Error(`${path}.maxResponseBytes 不能超过 10MB`);

  const response = stage.response;
  if (!response || !["json", "html"].includes(response.format)) {
    throw new Error(`${path}.response.format 必须是 json 或 html`);
  }
  const varEntries = Object.entries(response.vars || {});
  if (!varEntries.length || varEntries.length > MAX_STAGE_VARS) {
    throw new Error(`${path}.response.vars 需要 1 到 ${MAX_STAGE_VARS} 个提取变量`);
  }
  const extracted = new Set<string>();
  for (const [name, spec] of varEntries) {
    if (!VARIABLE_NAME_PATTERN.test(name)) {
      throw new Error(`${path}.response.vars.${name} 变量名必须是 1 到 32 位字母、数字、下划线，且以字母或下划线开头`);
    }
    if (RESERVED_VARIABLES.has(name)) {
      throw new Error(`${path}.response.vars.${name} 不允许覆盖保留变量`);
    }
    if (extracted.has(name)) throw new Error(`${path}.response.vars.${name} 重复定义`);
    const specPath = `${path}.response.vars.${name}`;
    validateFieldSpec(spec, specPath);
    const fieldSpec: InstructionField = typeof spec === "string" ? { path: spec, selector: spec } : spec;
    if (response.format === "json" && !fieldSpec.path && fieldSpec.source !== "constant") {
      throw new Error(`${specPath} 需要 path（JSON 格式）`);
    }
    if (response.format === "html" && !fieldSpec.selector && fieldSpec.source !== "constant") {
      throw new Error(`${specPath} 需要 selector（HTML 格式）`);
    }
    extracted.add(name);
  }
  return extracted;
}

/** Stages may only hit the main request host or an explicitly allowed domain. */
export function assertStageScope(
  stageUrl: URL,
  mainUrl: URL | null,
  allowedDomains?: string[]
): void {
  const stageHost = stageUrl.hostname.toLowerCase();
  if (mainUrl && stageHost === mainUrl.hostname.toLowerCase()) return;
  const allowed = (allowedDomains ?? []).map((domain) =>
    domain.toLowerCase().replace(/^\.+/, "").replace(/\.$/, "")
  );
  if (!allowed.length) {
    throw new Error(
      mainUrl
        ? `stages 仅允许访问主请求同域或白名单域: ${stageHost}`
        : `stages 需要显式 allowedDomains 白名单: ${stageHost}`
    );
  }
  if (!allowed.some((domain) => stageHost === domain || stageHost.endsWith(`.${domain}`))) {
    throw new Error(`stages URL 域名不在允许白名单: ${stageHost}`);
  }
}

export function validateInstructionDefinition(input: unknown): InstructionPluginDefinition {
  assertNoForbiddenKeys(input);
  const definition = input as Partial<InstructionPluginDefinition>;
  if (definition.schemaVersion !== 1) throw new Error("仅支持 schemaVersion: 1");
  const manifest = definition.manifest;
  if (!manifest?.id || !manifest.name || !manifest.version || manifest.kind !== "instructions") {
    throw new Error("manifest 必须包含 id、name、version，且 kind 必须为 instructions");
  }
  if (!Number.isInteger(manifest.priority) || manifest.priority < 0 || manifest.priority > 1000) {
    throw new Error("manifest.priority 必须是 0 到 1000 的整数");
  }
  if (!Number.isInteger(manifest.timeoutMs) || manifest.timeoutMs < 1000 || manifest.timeoutMs > 120000) {
    throw new Error("manifest.timeoutMs 必须是 1000 到 120000 的整数");
  }
  if (!Number.isInteger(manifest.maxResults) || manifest.maxResults < 1 || manifest.maxResults > 1000) {
    throw new Error("manifest.maxResults 必须是 1 到 1000 的整数");
  }
  if (manifest.upstreamGroup !== undefined && (typeof manifest.upstreamGroup !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(manifest.upstreamGroup))) {
    throw new Error("manifest.upstreamGroup 必须是 1 到 64 位字母、数字、下划线或连字符");
  }
  if (manifest.upstreamWeight !== undefined && (!Number.isInteger(manifest.upstreamWeight) || manifest.upstreamWeight < 1 || manifest.upstreamWeight > 100)) {
    throw new Error("manifest.upstreamWeight 必须是 1 到 100 的整数");
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
  const fallbackUrls = request.fallbackUrls ?? [];
  if (!Array.isArray(fallbackUrls) || fallbackUrls.length > 3) {
    throw new Error("request.fallbackUrls 必须是最多 3 个备用 URL 的数组");
  }
  for (const [index, fallbackUrl] of fallbackUrls.entries()) {
    if (typeof fallbackUrl !== "string" || !fallbackUrl.trim()) {
      throw new Error(`request.fallbackUrls[${index}] 必须是非空字符串`);
    }
    validateOutboundUrl(fallbackUrl, urlOptions);
  }
  const retry = request.retry;
  if (retry !== undefined) {
    if (!retry || typeof retry !== "object" || Array.isArray(retry)) {
      throw new Error("request.retry 必须是对象");
    }
    if (retry.maxRetries !== undefined && (!Number.isInteger(retry.maxRetries) || retry.maxRetries < 0 || retry.maxRetries > 3)) {
      throw new Error("request.retry.maxRetries 必须是 0 到 3 的整数");
    }
    if (retry.delayMs !== undefined && (!Number.isInteger(retry.delayMs) || retry.delayMs < 0 || retry.delayMs > 5000)) {
      throw new Error("request.retry.delayMs 必须是 0 到 5000 的整数");
    }
  }
  const secretNames = validateSecretNames(request);
  rejectSecretsInUrlOrQuery(request.url, request.query, secretNames, "request.url");
  fallbackUrls.forEach((fallbackUrl, index) => {
    rejectSecretsInUrlOrQuery(fallbackUrl, request.query, secretNames, `request.fallbackUrls[${index}]`);
  });

  // Stages run sequentially; stage i may only reference variables extracted
  // by earlier stages, plus reserved variables and declared secrets.
  const stages = request.stages ?? [];
  if (stages.length > MAX_STAGES) throw new Error(`request.stages 最多 ${MAX_STAGES} 个阶段`);
  const stageVarNames = new Set<string>();
  let allowedSoFar: ReadonlySet<string> = RESERVED_VARIABLES;
  stages.forEach((stage, index) => {
    const extracted = validateStage(stage, index, allowedSoFar, secretNames, urlOptions);
    for (const name of extracted) stageVarNames.add(name);
    allowedSoFar = new Set([...RESERVED_VARIABLES, ...stageVarNames]);
  });

  const allAllowed = new Set([...RESERVED_VARIABLES, ...stageVarNames, ...secretNames]);
  validateTemplates(
    {
      url: request.url,
      fallbackUrls: request.fallbackUrls,
      query: request.query,
      headers: request.headers,
      body: request.body,
    },
    allAllowed
  );
  if (stages.length) {
    // Static scope check: stage hosts must equal the main request host or sit
    // inside the explicit allowlist. Values are placeholders here; the
    // executor re-checks with real interpolated values at runtime.
    const placeholderVars: Record<string, string> = {};
    for (const name of stageVarNames) placeholderVars[name] = "";
    let scopeUrl: URL | null = null;
    try {
      scopeUrl = new URL(interpolateTemplate(request.url, placeholderVars, allAllowed) as string);
    } catch {
      scopeUrl = null;
    }
    stages.forEach((stage, index) => {
      let stageUrl: URL;
      try {
        stageUrl = new URL(interpolateTemplate(stage.url, placeholderVars, allAllowed) as string);
      } catch (error) {
        throw new Error(
          `request.stages[${index}].url 无法解析用于域校验的 URL: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      assertStageScope(stageUrl, scopeUrl, request.allowedDomains);
    });
  }
  for (const name of Object.keys(request.headers || {})) {
    if (isForbiddenOutboundHeader(name)) {
      throw new Error(`request.headers.${name} 不允许设置`);
    }
  }
  if ((request.maxResponseBytes ?? 0) > 10 * 1024 * 1024) throw new Error("request.maxResponseBytes 不能超过 10MB");
  if ((request.maxRequestBodyBytes ?? 0) > 256 * 1024) throw new Error("request.maxRequestBodyBytes 不能超过 256KB");
  const response = definition.response;
  if (!response || !["json", "html"].includes(response.format)) {
    throw new Error("response.format 必须是 json 或 html");
  }
  const hasTransform = typeof response.transform === "string" && response.transform.trim().length > 0;
  if (response.transform !== undefined && typeof response.transform !== "string") {
    throw new Error("response.transform 必须是字符串");
  }
  // A function transform owns the complete response shape. Keep the mapping
  // fields optional in that mode so a configured upstream is truly request +
  // transform, rather than a second hidden adapter configuration.
  if (!hasTransform && (typeof response.items !== "string" || !response.fields?.title || !response.links?.url)) {
    throw new Error("未配置 transform 时，response.items、response.fields.title 和 response.links.url 是必填项");
  }
  if (!hasTransform) {
    // JSON APIs may return the result array at the document root (an empty
    // mapping path means root). HTML still needs a CSS selector to identify
    // result cards.
    if (response.format === "html" && !response.items.trim()) {
      throw new Error("HTML 响应的 response.items 必须是 CSS 选择器");
    }
    if (response.format === "html" && !response.links.selector && response.links.array) {
      throw new Error("HTML 配置应使用 response.links.selector，而不是 links.array");
    }
    validateResponseInstructions(response);
  }
  return structuredClone(definition as InstructionPluginDefinition);
}
