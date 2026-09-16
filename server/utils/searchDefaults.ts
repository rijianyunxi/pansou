import { getSearchSettings } from "../core/services/searchSettingsService";
import { getSystemSettings } from "../core/services/systemSettingsService";
import { getUserPolicy } from "../core/services/policyService";

export interface EffectiveSearchParams {
  sourceIds?: string[];
  channels?: string[];
  conc?: number;
  ext: Record<string, any>;
}
export function applySearchDefaults(req: { sourceIds?: string[]; channels?: string[]; conc?: number; ext?: Record<string, any> }): EffectiveSearchParams {
  const system = getSystemSettings(useRuntimeConfig());
  const policy = getUserPolicy();
  const settings = getSearchSettings();
  return {
    sourceIds: req.sourceIds ?? settings.sources ?? undefined,
    channels: req.channels ?? settings.channels ?? system.defaultChannels,
    conc: req.conc ?? policy.defaultConcurrency,
    ext: { ...(req.ext || {}) },
  };
}
