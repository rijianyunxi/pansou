import type { SearchResult } from "../types/models";
import { getUnifiedUpstream } from "../services/upstreamCatalog";
import { isCoreCompatibleConfiguration } from "../services/configuredUpstreamPlugin";
import { parseWithParserPlugin } from "./runtime";
import type { ParserInputFormat, ParserPluginRecord } from "./types";

function configuredTransformRecord(upstreamId: string): ParserPluginRecord | null {
  const source = getUnifiedUpstream(upstreamId);
  // Core remains a capability for untouched shipped rows. Its handler owns
  // special flows (pagination/build IDs); the configured transform takes over
  // as soon as any executable field, including transform itself, is changed.
  if (!source || isCoreCompatibleConfiguration(source)) return null;
  const code = source.transform?.trim();
  if (!code) return null;
  return {
    id: source.id,
    status: "published",
    publishedVersion: `config:${source.id}`,
    manifest: {
      id: source.id,
      name: source.name,
      version: `config:${source.id}`,
      description: source.description,
      format: source.format,
      target: "upstream",
      timeoutMs: Math.min(Math.max(source.request?.timeoutMs ?? 5_000, 100), 5_000),
      maxResults: 200,
    },
    code,
    versions: [],
    createdAt: "",
    updatedAt: "",
    updatedBy: "config",
  };
}

/**
 * Execute the transform stored on the unified upstream row.
 *
 * Parser code is still sandboxed by the common runtime, but it is no longer a
 * separately published/bound plugin. A missing transform returns null so the
 * legacy core adapter can handle old rows during migration.
 */
export function parseConfiguredUpstreamResponse(
  upstreamId: string,
  payload: unknown,
  format: ParserInputFormat,
  context: { keyword: string; url: string; page?: number; rawBody?: string },
): SearchResult[] | null {
  const record = configuredTransformRecord(upstreamId);
  if (!record) return null;
  const rawBody = context.rawBody ?? (format === "json" ? JSON.stringify(payload) : String(payload));
  return parseWithParserPlugin(record, rawBody, {
    rawBody,
    format,
    keyword: context.keyword,
    source: upstreamId,
    url: context.url,
    page: context.page,
  });
}
