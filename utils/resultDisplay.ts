import type { SearchResult } from "../server/core/types/models";

/**
 * UI projection only: the API keeps one resource with several links, while
 * the result list shows one card per link.
 */
export type DisplaySearchResult = SearchResult & {
  displayKey: string;
  sourceResource: SearchResult;
};

export function flattenResultsForDisplay(results: SearchResult[]): DisplaySearchResult[] {
  return results.flatMap((resource) => resource.links.map((link, index) => ({
    ...resource,
    id: `${resource.id}::${index}`,
    cloud_types: [link.type],
    links: [link],
    displayKey: `${resource.id}|${link.type}|${link.url}|${index}`,
    sourceResource: resource,
  })));
}
