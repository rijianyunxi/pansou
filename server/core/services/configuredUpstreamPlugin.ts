import { BUILTIN_UPSTREAMS, type UpstreamDefinition } from "../../../config/upstreams";
import type { InstructionPluginDefinition } from "../instructions/types";
import { InstructionsPlugin, type SecretValuesLoader } from "../instructions/plugin";
import type { SearchPlugin } from "../plugins/manager";

const DEFAULT_HTML_ITEMS = ".result";

const CORE_ADAPTER_BY_ID: Record<string, string> = {
  hunhepan: "disk-json",
  nyaa: "nyaa-html",
  pansearch: "next-data",
  duoduo: "html-probe",
};

function canonicalOptionalConfig(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  // The editor may submit an empty request object when no advanced fields were
  // entered. Treat that as omitted, just like the shipped seed definition.
  const serialized = JSON.stringify(value);
  if (!serialized || serialized === "{}") return undefined;
  return JSON.parse(serialized);
}

function executionShape(source: UpstreamDefinition): string {
  // Catalog rows are sanitized before they reach the runtime. Compare a
  // canonical shape rather than the raw object so harmless differences such
  // as omitted optional mapping keys (or an empty `linkArray`) do not disable
  // a Core capability on every request after the first SQLite seed.
  const mapping = source.mapping || {};
  return JSON.stringify({
    url: source.url,
    method: source.method,
    requestUrl: source.request?.url || "",
    format: source.format,
    adapter: source.adapter,
    mapping: {
      items: mapping.items || "",
      title: mapping.title || "",
      url: mapping.url || "",
      type: mapping.type || "",
      password: mapping.password || "",
      linkArray: mapping.linkArray || "",
      content: mapping.content || "",
      datetime: mapping.datetime || "",
    },
    request: canonicalOptionalConfig(source.request),
    response: canonicalOptionalConfig(source.response),
    transform: source.transform || "",
  });
}

/**
 * Core is a capability, not the configuration source. It is safe to use only
 * while the executable fields still match the shipped seed. Any endpoint,
 * method, format, mapping, request, or pagination edit is therefore routed
 * through the declarative executor on the next search/probe.
 */
export function isCoreCompatibleConfiguration(source: UpstreamDefinition): boolean {
  const seed = BUILTIN_UPSTREAMS.find((item) => item.id === source.id);
  const handler = source.runtime?.kind === "core" ? source.runtime.handler : "";
  return !!seed && !!handler && CORE_ADAPTER_BY_ID[source.id] === source.adapter &&
    seed.runtime?.kind === "core" && seed.runtime.handler === handler &&
    executionShape(source) === executionShape(seed);
}

function configurationVersion(source: UpstreamDefinition): string {
  const input = JSON.stringify({
    url: source.url,
    fallbackUrls: source.fallbackUrls || [],
    retry: source.retry || null,
    method: source.method,
    format: source.format,
    mapping: source.mapping,
    request: source.request,
    response: source.response,
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
 * Turn the catalog row into the declarative runtime definition.  The catalog
 * is the only source of endpoint/mapping settings; this adapter is deliberately
 * boring so core capabilities and configured sources use the same executor.
 */
export function upstreamToInstructionDefinition(
  source: UpstreamDefinition,
): InstructionPluginDefinition {
  const request = source.request;
  const primaryRequestUrl = request?.url || source.url;
  const fallbackUrls = request?.fallbackUrls ?? source.fallbackUrls ?? [];
  const requestOrigins = [primaryRequestUrl, ...fallbackUrls]
    .map((value) => {
      try { return new URL(value).hostname; } catch { return ""; }
    })
    .filter(Boolean);
  const allowedDomains = request?.allowedDomains?.length
    ? request.allowedDomains
    : [...new Set([new URL(source.url).hostname, ...requestOrigins])];
  const isJson = source.format === "json";
  const responseItems = isJson ? source.mapping.items : (source.mapping.items || DEFAULT_HTML_ITEMS);

  return {
    schemaVersion: 1,
    manifest: {
      id: source.id,
      name: source.name,
      version: configurationVersion(source),
      kind: "instructions",
      priority: 2,
      timeoutMs: request?.timeoutMs ?? 10_000,
      maxResults: 200,
      schemaVersion: 1,
      outputTypes: [],
    },
    request: {
      method: source.method,
      url: primaryRequestUrl,
      fallbackUrls: fallbackUrls.length ? fallbackUrls : undefined,
      retry: request?.retry ?? source.retry,
      query: request?.query as InstructionPluginDefinition["request"]["query"] ?? (source.method === "GET" ? { keyword: "{{keyword}}" } : undefined),
      headers: request?.headers,
      bodyType: source.method === "POST" ? (request?.bodyType ?? "json") : undefined,
      body: source.method === "POST" ? (request?.body as InstructionPluginDefinition["request"]["body"] ?? { keyword: "{{keyword}}" }) : undefined,
      timeoutMs: request?.timeoutMs,
      maxResponseBytes: request?.maxResponseBytes,
      redirect: request?.redirect,
      allowedDomains,
      allowInsecureHttp: false,
      maxRequestBodyBytes: request?.maxRequestBodyBytes,
      secrets: request?.secrets,
      stages: request?.stages as InstructionPluginDefinition["request"]["stages"],
    },
    response: isJson
      ? {
          format: "json",
          ...(source.transform?.trim() ? { transform: source.transform } : {}),
          items: responseItems,
          fields: {
            title: source.mapping.title,
            content: source.mapping.content || undefined,
            datetime: source.mapping.datetime || undefined,
          },
          links: {
            array: source.mapping.linkArray || undefined,
            url: source.mapping.url,
            type: source.mapping.type || undefined,
            password: source.mapping.password || undefined,
          },
          nextPage: source.response?.nextPage,
        }
      : {
          format: "html",
          ...(source.transform?.trim() ? { transform: source.transform } : {}),
          items: responseItems,
          fields: {
            title: source.mapping.title || ".title",
            content: source.mapping.content || undefined,
            datetime: source.mapping.datetime || undefined,
          },
          links: {
            selector: source.mapping.linkArray || "a[href]",
            url: source.mapping.url
              ? { selector: source.mapping.url, source: "href" as const }
              : { source: "href" as const },
            type: source.mapping.type ? { selector: source.mapping.type } : undefined,
            password: source.mapping.password ? { selector: source.mapping.password } : undefined,
          },
          nextPage: source.response?.nextPage,
        },
  };
}

export function createConfiguredUpstreamPlugin(
  source: UpstreamDefinition,
  loadSecrets?: SecretValuesLoader,
): SearchPlugin {
  return new InstructionsPlugin(upstreamToInstructionDefinition(source), loadSecrets);
}
