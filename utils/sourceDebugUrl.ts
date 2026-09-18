import type { ProbeRequestDetails, SourceDefinition } from "../types/source";

const TEMPLATE_PATTERN = /{{\s*([^{}]+?)\s*}}/g;
const SENSITIVE_KEY = /(?:authorization|cookie|token|api[-_]?key|secret|password|passwd|credential|signature)/i;

type DebugVariables = Record<string, string | number>;

function renderTemplate(value: unknown, variables: DebugVariables): unknown {
  if (typeof value === "string") {
    return value.replace(TEMPLATE_PATTERN, (match, name: string) => (
      Object.prototype.hasOwnProperty.call(variables, name)
        ? String(variables[name])
        : match
    ));
  }
  if (Array.isArray(value)) return value.map((item) => renderTemplate(item, variables));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[REDACTED]" : renderTemplate(child, variables),
      ]),
    );
  }
  return value;
}

function renderUrlTemplate(value: string, variables: DebugVariables): string {
  return value.replace(TEMPLATE_PATTERN, (match, name: string) => (
    Object.prototype.hasOwnProperty.call(variables, name)
      ? encodeURIComponent(String(variables[name]))
      : match
  ));
}

function parameterText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value);
}

function appendParameters(
  url: URL,
  values: Record<string, unknown> | undefined,
  variables: DebugVariables,
): void {
  if (!values) return;
  for (const [key, rawValue] of Object.entries(values)) {
    if (rawValue === undefined) continue;
    const value = SENSITIVE_KEY.test(key) ? "[REDACTED]" : renderTemplate(rawValue, variables);
    url.searchParams.set(key, parameterText(value));
  }
}

function appendBodyPreview(url: URL, body: unknown, variables: DebugVariables): void {
  if (body === undefined) return;
  const rendered = renderTemplate(body, variables);
  if (rendered && typeof rendered === "object" && !Array.isArray(rendered)) {
    appendParameters(url, rendered as Record<string, unknown>, variables);
    return;
  }
  url.searchParams.set("_body", parameterText(rendered));
}

function debugVariables(_source: SourceDefinition, keyword: string): DebugVariables {
  return {
    keyword: keyword.trim(),
    limit: 200,
  };
}

function renderedSourceUrl(source: SourceDefinition, variables: DebugVariables): string {
  let renderedUrl = renderUrlTemplate(source.url, variables);
  if (TEMPLATE_PATTERN.test(renderedUrl)) {
    TEMPLATE_PATTERN.lastIndex = 0;
    renderedUrl = renderUrlTemplate(source.url, variables);
  }
  TEMPLATE_PATTERN.lastIndex = 0;
  return renderedUrl;
}

function queryRecord(url: URL): Record<string, string | string[]> {
  return Object.fromEntries([...new Set(url.searchParams.keys())].map((key) => {
    const values = url.searchParams.getAll(key);
    return [key, values.length > 1 ? values : values[0] || ""];
  }));
}

/** Best-effort preview used before the server returns the exact rendered request. */
export function buildSourceRequestPreview(
  source: SourceDefinition,
  keyword: string,
): ProbeRequestDetails {
  const variables = debugVariables(source, keyword);
  const renderedUrl = renderedSourceUrl(source, variables);
  const url = new URL(renderedUrl);
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_KEY.test(key)) url.searchParams.set(key, "[REDACTED]");
  }
  const query = source.request?.query ?? (source.method === "GET" ? { keyword: "{{keyword}}" } : undefined);
  appendParameters(url, query, variables);

  const headers = renderTemplate({
    accept: source.format === "json" || source.request?.bodyType === "json" ? "application/json" : "text/html",
    ...(source.request?.headers || {}),
  }, variables) as Record<string, string>;
  let body: unknown = undefined;
  if (source.method === "POST") {
    body = renderTemplate(source.request?.body ?? { keyword: "{{keyword}}" }, variables);
    headers["content-type"] ||= source.request?.bodyType === "form"
      ? "application/x-www-form-urlencoded"
      : "application/json";
  }
  return {
    url: url.toString(),
    query: queryRecord(url),
    headers,
    ...(body !== undefined ? { body } : {}),
  };
}

/**
 * Build a browser-openable request preview for the source directory.
 * Explicit query values match the real request. POST body fields are mirrored
 * into the query string so they remain inspectable when opened in a new tab.
 */
export function buildSourceDebugUrl(
  source: SourceDefinition,
  keyword: string,
): string {
  try {
    const preview = buildSourceRequestPreview(source, keyword);
    const url = new URL(preview.url);
    if (source.method === "POST") appendBodyPreview(url, preview.body, debugVariables(source, keyword));
    return url.toString();
  } catch {
    return source.url;
  }
}

/** Build the stable address shown in the source directory without a keyword. */
export function buildSourceCatalogUrl(source: SourceDefinition): string {
  const marker = "__panhub_keyword__";
  try {
    const rendered = renderedSourceUrl(source, { keyword: marker, limit: 200 });
    const url = new URL(rendered);
    for (const key of [...url.searchParams.keys()]) {
      if (url.searchParams.getAll(key).some((value) => value.includes(marker))) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return source.url;
  }
}
