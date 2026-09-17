import { normalizeTelegramChannels, TG_CHANNEL_PATTERN } from "../../utils/telegramChannels";

/**
 * Lifecycle override state for resource sources that are backed by a public
 * channel username. A row only exists while a source is toggled off or
 * archived; "enabled and not archived" is represented by the absence of a row.
 */
export interface SourceLifecycleEntry { enabled: boolean; deleted: boolean; }
export type SourceLifecycleMap = Record<string, SourceLifecycleEntry>;

export function sanitizeSourceLifecycleStates(value: unknown): SourceLifecycleMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: SourceLifecycleMap = {};
  for (const [rawKey, rawEntry] of Object.entries(value as Record<string, unknown>)) {
    const name = normalizeSourceParam(rawKey);
    if (!TG_CHANNEL_PATTERN.test(name) || !rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue;
    const input = rawEntry as Record<string, unknown>;
    const enabled = typeof input.enabled === "boolean" ? input.enabled : true;
    const deleted = typeof input.deleted === "boolean" ? input.deleted : false;
    if (enabled && !deleted) continue;
    out[name] = { enabled, deleted };
  }
  return out;
}

/** Public channel usernames are stored without the leading @ and lower-cased. */
export function normalizeSourceParam(value: string | undefined | null): string {
  return String(value ?? "").trim().replace(/^@/, "").toLowerCase();
}

/**
 * Configured channel lists, normalized once per request.
 *
 * A monitor response resolves the origin of every source, so building the sets
 * per lookup would re-normalize the same two lists dozens of times.
 */
export interface SourceOriginContext {
  custom: Set<string>;
  builtin: Set<string>;
}

export function createSourceOriginContext(
  customChannels: string[] | null,
  builtinDefaults: string[],
): SourceOriginContext {
  return {
    custom: new Set(normalizeTelegramChannels(customChannels ?? [])),
    builtin: new Set(normalizeTelegramChannels(builtinDefaults ?? [])),
  };
}

/**
 * Which configured list a channel source came from, for admin display only.
 * Non-channel ids have no origin at all. A channel listed in both places counts
 * as custom, and an unlisted channel is treated as custom too because it can
 * only have been added by an operator.
 */
export function sourceOrigin(
  sourceId: string,
  origins: SourceOriginContext,
): "builtin" | "custom" | "" {
  if (!TG_CHANNEL_PATTERN.test(sourceId)) return "";
  if (origins.custom.has(sourceId)) return "custom";
  return origins.builtin.has(sourceId) ? "builtin" : "custom";
}
