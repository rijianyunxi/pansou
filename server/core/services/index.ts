import { SearchService, type SearchServiceOptions } from "./searchService";
import { getUserPolicy } from "./policyService";

const SERVICE_CONTEXT_KEY = "__panhub_search_service__";

function createServiceOptions(): SearchServiceOptions {
  const policy = getUserPolicy();
  return {
    defaultConcurrency: policy.defaultConcurrency,
    cacheTtlMinutes: policy.cacheTtlMinutes,
  };
}

export function getOrCreateSearchService(): SearchService {
  const context = (globalThis as any)[SERVICE_CONTEXT_KEY];
  if (context?.service) return context.service;
  const options = createServiceOptions();
  const service = new SearchService(options);
  (globalThis as any)[SERVICE_CONTEXT_KEY] = { service, options };
  return service;
}
