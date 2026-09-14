import type { UpstreamDefinition } from "../../../types/source";
import type { InstructionPluginDefinition } from "../instructions/types";
import { InstructionsPlugin, type SecretValuesLoader } from "../instructions/plugin";
import type { SearchPlugin } from "../plugins/manager";

const DEFAULT_HTML_ITEMS = ".result";

function configurationVersion(source: UpstreamDefinition): string {
  const input = JSON.stringify({
    url: source.url,
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
 * is the only source of endpoint/mapping settings; this adapter deliberately
 * contains no source-specific behavior.
 */
export function upstreamToInstructionDefinition(
  source: UpstreamDefinition,
): InstructionPluginDefinition {
  const request = source.request;
  const allowedDomains = request?.allowedDomains?.length
    ? request.allowedDomains
    : [new URL(source.url).hostname];
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
      url: source.url,
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
