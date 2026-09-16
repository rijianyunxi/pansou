import { SearchService, type SearchServiceOptions } from "./searchService";
import { getSystemSettings } from "./systemSettingsService";
import { listUnifiedUpstreams } from "./upstreamCatalog";

const SERVICE_CONTEXT_KEY = "__panhub_search_service__";

function createServiceOptions(runtimeConfig: any): SearchServiceOptions {
  const system = getSystemSettings(runtimeConfig);
  return {
    defaultSourceIds: [],
    defaultConcurrency: system.defaultConcurrency,
    searchTimeoutMs: runtimeConfig.searchTimeoutMs,
    cacheEnabled: !!runtimeConfig.cacheEnabled,
    cacheTtlMinutes: system.cacheTtlMinutes,
    sourceLoader: async () => listUnifiedUpstreams(),
  };
}

export function getOrCreateSearchService(runtimeConfig: any): SearchService {
  const context = (globalThis as any)[SERVICE_CONTEXT_KEY];
  if (context?.service) return context.service;
  const options = createServiceOptions(runtimeConfig);
  const service = new SearchService(options);
  (globalThis as any)[SERVICE_CONTEXT_KEY] = { service, options };
  return service;
}
