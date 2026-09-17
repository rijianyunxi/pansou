import { defineEventHandler } from "h3";
import { getOrCreateSearchService } from "../core/services";
import { getSystemSettings } from "../core/services/systemSettingsService";
import { listUnifiedSources } from "../core/services/sourceCatalog";
import { getSourceConfigurationVersion } from "../core/services/configuredSource";
import { setNoStore } from "../utils/apiResponse";

/**
 * Liveness plus source status. The shape is consumed by external monitors, so
 * the legacy `sources`/`resource_sources` fields are kept as-is.
 */
export default defineEventHandler((event) => {
  setNoStore(event);
  const service = getOrCreateSearchService();
  const system = getSystemSettings(useRuntimeConfig());
  const health = service.getSourceHealthStatus();
  const healthById = new Map(health.map((item) => [item.id || item.name, item]));
  const sources = listUnifiedSources().map((source) => ({
    id: source.id,
    name: source.name,
    priority: source.priority,
    version: getSourceConfigurationVersion(source),
    enabled: source.enabled !== false,
    health: healthById.get(source.id),
  }));
  return {
    status: "ok",
    sources_enabled: sources.filter((source) => source.enabled).length,
    sources,
    channels: system.defaultChannels,
    liveness: { status: "ok", checked_at: new Date().toISOString() },
    resource_sources: { count: health.length, sources: health },
  };
});
