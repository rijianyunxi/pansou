import { defineEventHandler } from "h3";
import { getOrCreateSearchService } from "../core/services";
import { getSystemSettings } from "../core/services/systemSettingsService";
import { listUnifiedUpstreams } from "../core/services/upstreamCatalog";
import { getSourceConfigurationVersion } from "../core/services/configuredSource";

export default defineEventHandler(() => {
  const config = useRuntimeConfig();
  const service = getOrCreateSearchService(config);
  const system = getSystemSettings(config);
  const health = service.getSourceHealthStatus() as Array<any>;
  const healthById = new Map(health.map((item) => [item.id || item.name, item]));
  const sources = listUnifiedUpstreams().map((source) => ({ id: source.id, name: source.name, priority: source.priority, version: getSourceConfigurationVersion(source), enabled: source.enabled !== false, health: healthById.get(source.id) }));
  return { status: "ok", sources_enabled: sources.filter((source) => source.enabled).length, sources, channels: system.defaultChannels, liveness: { status: "ok", checked_at: new Date().toISOString() }, resource_sources: { count: health.length, sources: health } };
});
