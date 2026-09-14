import type {
  CloudType,
  Link,
  NormalizedCloudLink,
  NormalizedSearchResult,
  NormalizedSearchSourceUpdate,
  SearchExecutionResponse,
  SearchResponse,
  SearchResult,
  SearchSourceUpdate,
} from "../types/models";
import { inferDriveType, normalizeCloudType } from "../../../utils/upstreamAdapter";

const API_TIME_ZONE = "Asia/Shanghai";

function cleanText(value: unknown): string {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\((?:https?:\/\/[^)\s]+)\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[\\*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatDateParts(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: API_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}/${values.month}/${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

/** Formats all public search timestamps as YYYY/MM/DD HH:mm:ss in China time. */
export function formatSearchDateTime(value?: string | null): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const dateOnly = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(raw);
  if (dateOnly) {
    return `${dateOnly[1]}/${dateOnly[2]!.padStart(2, "0")}/${dateOnly[3]!.padStart(2, "0")} 00:00:00`;
  }
  const naive = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  const timestamp = naive
    ? Date.parse(`${naive[1]}-${naive[2]!.padStart(2, "0")}-${naive[3]!.padStart(2, "0")}T${naive[4]!.padStart(2, "0")}:${naive[5]}:${(naive[6] || "00").padStart(2, "0")}+08:00`)
    : Date.parse(raw);
  return Number.isFinite(timestamp) ? formatDateParts(new Date(timestamp)) : null;
}

function normalizeLink(link: Link): NormalizedCloudLink | null {
  const url = String(link?.url ?? "").trim();
  if (!url) return null;
  return { type: inferDriveType(url, link.type), url, password: String(link.password ?? "").trim() || null };
}

function allowedCloudTypes(values?: string[]): Set<CloudType> | undefined {
  if (!values?.length) return undefined;
  const normalized = values.map(normalizeCloudType).filter((value): value is CloudType => !!value);
  return normalized.length ? new Set(normalized) : undefined;
}

function resultId(result: SearchResult, name: string, links: NormalizedCloudLink[]): string {
  return result.unique_id || result.message_id || links[0]?.url || `${name}|${result.datetime || ""}`;
}

export function normalizeSearchResult(result: SearchResult, includeDebug = false, cloudTypeFilter?: string[]): NormalizedSearchResult {
  const allowed = allowedCloudTypes(cloudTypeFilter);
  const links = result.links.map(normalizeLink)
    .filter((link): link is NormalizedCloudLink => link !== null)
    .filter((link) => !allowed || allowed.has(link.type));
  const name = cleanText(result.title) || cleanText(result.content).slice(0, 120) || "未命名资源";
  const description = cleanText(result.content) || null;
  const normalized: NormalizedSearchResult = {
    id: resultId(result, name, links), name, description,
    datetime: formatSearchDateTime(result.datetime),
    cloud_types: [...new Set(links.map((link) => link.type))], links,
    ...(result.tags?.length ? { tags: result.tags } : {}),
    ...(result.images?.length ? { images: result.images } : {}),
  };
  if (includeDebug) {
    Object.assign(normalized, {
      ...(result.source ? { source: result.source } : {}),
      ...(result.channel ? { channel: result.channel } : {}),
      ...(result.pluginId ? { pluginId: result.pluginId } : {}),
      ...(result.pluginVersion ? { pluginVersion: result.pluginVersion } : {}),
      ...(result.registryVersion !== undefined ? { registryVersion: result.registryVersion } : {}),
    });
  }
  return normalized;
}

export function normalizeSearchResponse(response: SearchExecutionResponse, includeDebug = false, cloudTypeFilter?: string[]): SearchResponse {
  const results = response.results
    .map((result) => normalizeSearchResult(result, includeDebug, cloudTypeFilter))
    .filter((result) => result.links.length > 0);
  return { ...response, total: results.length, results };
}

export function normalizeSearchUpdate(update: SearchSourceUpdate, includeDebug = false, cloudTypes?: string[]): NormalizedSearchSourceUpdate {
  return {
    ...update,
    results: update.results
      .map((result) => normalizeSearchResult(result, includeDebug, cloudTypes))
      .filter((result) => result.links.length > 0),
  };
}

export function isNormalizedSearchResult(item: unknown): item is NormalizedSearchResult {
  return !!item && typeof item === "object" && typeof (item as NormalizedSearchResult).id === "string" &&
    Array.isArray((item as NormalizedSearchResult).cloud_types) && Array.isArray((item as NormalizedSearchResult).links);
}
