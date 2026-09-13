import { createError } from "h3";
import { getSearchSettings, type SearchSettings } from "../core/services/searchSettingsService";
import { getSystemSettings } from "../core/services/systemSettingsService";
import type { SearchRequest } from "../core/types/models";
import { normalizeTelegramChannels, TG_CHANNEL_PATTERN } from "../../utils/telegramChannels";

export interface SearchDefaultsInput {
  channels?: string[];
  plugins?: string[];
  conc?: number;
  channelsMode?: string;
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

/** Pure resolver; [] explicitly disables a source, null/undefined selects defaults. */
export function resolveSearchDefaults(
  req: SearchDefaultsInput,
  settings: SearchSettings,
  config: { defaultChannels?: string[] },
): EffectiveSearchParams {
  const own = normalizeTelegramChannels(req.channels ?? []);
  const only = req.channelsMode === "only";
  if (only && !own.length) throw createError({ statusCode: 400, statusMessage: "channels are required when channels_mode=only" });
  const defaults = settings.channels ?? config.defaultChannels ?? [];
  const channels = normalizeTelegramChannels(only ? own : [...defaults, ...own])
    .filter((name) => TG_CHANNEL_PATTERN.test(name));
  const src = only ? "tg" : req.src ?? "all";
  const ext = { ...req.ext };
  if (ext.__plugin_timeout_ms === undefined && settings.pluginTimeoutMs) ext.__plugin_timeout_ms = settings.pluginTimeoutMs;
  return {
    channels: src === "plugin" ? [] : channels,
    plugins: only ? [] : req.plugins ?? settings.plugins ?? undefined,
    src, conc: req.conc ?? settings.concurrency ?? undefined, ext,
  };
}

export function applySearchDefaults(req: SearchDefaultsInput): EffectiveSearchParams {
  const system = getSystemSettings(useRuntimeConfig());
  return resolveSearchDefaults(req, getSearchSettings(), system);
}
