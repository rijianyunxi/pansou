import { getSearchSettings } from "../core/services/searchSettingsService";
import { getSystemSettings } from "../core/services/systemSettingsService";

export interface EffectiveSearchParams {
  sourceIds?: string[];
  channels?: string[];
  conc?: number;
  ext: Record<string, any>;
}
export function applySearchDefaults(req: { sourceIds?: string[]; channels?: string[]; conc?: number; ext?: Record<string, any> }): EffectiveSearchParams {
  const system = getSystemSettings(useRuntimeConfig());
  const settings = getSearchSettings();
  return {
    sourceIds: req.sourceIds ?? settings.sources ?? undefined,
    channels: req.channels ?? settings.channels ?? system.defaultChannels,
    conc: req.conc ?? settings.concurrency ?? system.defaultConcurrency,
    ext: { ...(req.ext || {}) },
  };
}
