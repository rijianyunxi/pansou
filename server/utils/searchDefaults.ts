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
 * Channels are deliberately absent. The default channel list is not a search
 * parameter: channel-backed sources are materialized from it by
 * `sourceCatalog.listUnifiedSources()`, and a custom-channel search replaces
 * `request.channels` with the caller's stored list during authorization. A
 * resolved `channels` field here would therefore be computed on every request,
 * cost an extra `getSystemSettings()` read, and never be consumed.
 */
export function applySearchDefaults(req: { sourceIds?: string[]; conc?: number }): EffectiveSearchParams {
  const policy = getUserPolicy();
  const settings = getSearchSettings();
  return {
    sourceIds: req.sourceIds ?? settings.sources ?? undefined,
    conc: req.conc ?? policy.defaultConcurrency,
  };
}
