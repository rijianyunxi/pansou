// Two distinct shapes share the name: the catalog row stored in SQLite and the
// declarative runtime definition consumed by the executor. Only the runtime one
// is aliased, so `SourceDefinition` keeps meaning "catalog row" here.
import type { SourceDefinition } from "../../../types/source";
import type { SourceDefinition as RuntimeSourceDefinition } from "../source-runtime/types";

export function getSourceConfigurationVersion(source: SourceDefinition): string {
  const input = JSON.stringify({
    url: source.url,
    method: source.method,
    format: source.format,
    priority: source.priority ?? 0,
    request: source.request,
    transform: source.transform,
  });
  let hash = 2166136261;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `cfg-${(hash >>> 0).toString(16)}`;
}

/**
 * Turn a catalog row into the declarative runtime definition. The catalog has
 * one parsing model: transform(payload, $, context) owns the complete result
 * conversion, including the new resource-level result shape.
 */
export function toSourceDefinition(source: SourceDefinition): RuntimeSourceDefinition {
  const request = source.request;
  const transform = source.transform?.trim();
  if (!transform) throw new Error("来源必须配置 transform(payload, $, context)");
  const sourceHost = new URL(source.url).hostname.toLowerCase();
  const proxyPool = source.proxyPool === "telegram"
    || sourceHost === "t.me"
    || sourceHost === "www.t.me"
    || sourceHost === "telegram.me"
    ? "telegram"
    : undefined;
  const allowedDomains = request?.allowedDomains?.length
    ? request.allowedDomains
    : [new URL(source.url).hostname];

  return {
    schemaVersion: 1,
    manifest: {
      id: source.id,
      name: source.name,
      version: getSourceConfigurationVersion(source),
      kind: "source",
      maxResults: 200,
      schemaVersion: 1,
      outputTypes: [],
    },
    proxyPool,
    request: {
      method: source.method,
      url: source.url,
      query: request?.query as RuntimeSourceDefinition["request"]["query"] ?? (source.method === "GET" ? { keyword: "{{keyword}}" } : undefined),
      headers: request?.headers,
      bodyType: source.method === "POST" ? (request?.bodyType ?? "json") : undefined,
      body: source.method === "POST" ? (request?.body as RuntimeSourceDefinition["request"]["body"] ?? { keyword: "{{keyword}}" }) : undefined,
      maxResponseBytes: request?.maxResponseBytes,
      redirect: request?.redirect,
      allowedDomains,
      allowInsecureHttp: false,
      maxRequestBodyBytes: request?.maxRequestBodyBytes,
    },
    response: {
      format: source.format,
      transform,
    },
  };
}
