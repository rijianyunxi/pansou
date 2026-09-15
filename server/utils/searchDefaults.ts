import { getSearchSettings, type SearchSettings } from "../core/services/searchSettingsService";
import { getSystemSettings } from "../core/services/systemSettingsService";
import type { SearchRequest } from "../core/types/models";
import { normalizeTelegramChannels } from "../../utils/telegramChannels";

export interface SearchDefaultsInput {
  plugins?: string[];
  conc?: number;
  src?: SearchRequest["src"];
  ext?: Record<string, any>;
}
export interface EffectiveSearchParams {
  channels: string[];
  plugins?: string[];
  conc?: number;
  src: "all" | "tg" | "plugin";
  ext: Record<string, any>;
}

/** Resolve the server-configured search scope. User channel searches use a separate endpoint. */
export function resolveSearchDefaults(
  req: SearchDefaultsInput,
  settings: SearchSettings,
  config: { defaultChannels?: string[] },
): EffectiveSearchParams {
  const defaults = settings.channels ?? config.defaultChannels ?? [];
  const channels = normalizeTelegramChannels(defaults);
  const src = req.src ?? "all";
  const ext = { ...req.ext };
  if (ext.__plugin_timeout_ms === undefined && settings.pluginTimeoutMs) ext.__plugin_timeout_ms = settings.pluginTimeoutMs;
  return {
    channels: src === "plugin" ? [] : channels,
    plugins: req.plugins ?? settings.plugins ?? undefined,
    src, conc: req.conc ?? settings.concurrency ?? undefined, ext,
  };
}

export function applySearchDefaults(req: SearchDefaultsInput): EffectiveSearchParams {
  const system = getSystemSettings(useRuntimeConfig());
  return resolveSearchDefaults(req, getSearchSettings(), system);
}
