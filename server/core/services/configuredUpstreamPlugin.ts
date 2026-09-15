import type { UpstreamDefinition } from "../../../types/source";
import type { InstructionPluginDefinition } from "../instructions/types";
import { InstructionsPlugin } from "../instructions/plugin";
import type { SearchPlugin } from "../plugins/manager";

function configurationVersion(source: UpstreamDefinition): string {
  const input = JSON.stringify({
    url: source.url,
    method: source.method,
    format: source.format,
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
 * Turn a catalog row into the declarative runtime definition. The catalog has
 * one parsing model: transform(payload, $, context) owns the complete result
 * conversion, including the new resource-level result shape.
 */
export function upstreamToInstructionDefinition(source: UpstreamDefinition): InstructionPluginDefinition {
  const request = source.request;
  const transform = source.transform?.trim();
  if (!transform) throw new Error("来源必须配置 transform(payload, $, context)");
  const allowedDomains = request?.allowedDomains?.length
    ? request.allowedDomains
    : [new URL(source.url).hostname];

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
      stages: request?.stages as InstructionPluginDefinition["request"]["stages"],
    },
    response: {
      format: source.format,
      transform,
      nextPage: source.response?.nextPage,
    },
  };
}

export function createConfiguredUpstreamPlugin(source: UpstreamDefinition): SearchPlugin {
  return new InstructionsPlugin(upstreamToInstructionDefinition(source));
}
