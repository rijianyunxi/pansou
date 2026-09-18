import { getSearchSettings } from "../core/services/searchSettingsService";
import { getUserPolicy } from "../core/services/policyService";

export interface EffectiveSearchParams {
  sourceIds?: string[];
  conc?: number;
}

/**
 * Resolve the parameters a search actually runs with, filling in the
 * server-side defaults for anything the caller left out.
 *
 * User-owned custom resource sources are resolved separately by the search
 * authorization layer. The system search itself only uses this source list.
 */
export function applySearchDefaults(req: { sourceIds?: string[]; conc?: number }): EffectiveSearchParams {
  const policy = getUserPolicy();
  const settings = getSearchSettings();
  return {
    sourceIds: req.sourceIds ?? settings.sources ?? undefined,
    conc: req.conc ?? policy.defaultConcurrency,
  };
}
