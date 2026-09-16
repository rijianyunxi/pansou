import { SearchService, type SearchServiceOptions } from "./searchService";
import { listUnifiedUpstreams } from "./upstreamCatalog";
import { getUserPolicy } from "./policyService";

const SERVICE_CONTEXT_KEY = "__panhub_search_service__";

function createServiceOptions(runtimeConfig: any): SearchServiceOptions {
  const policy = getUserPolicy();
  return {
    defaultSourceIds: [],
    defaultConcurrency: policy.defaultConcurrency,
    cacheEnabled: !!runtimeConfig.cacheEnabled,
    cacheTtlMinutes: policy.cacheTtlMinutes,
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
