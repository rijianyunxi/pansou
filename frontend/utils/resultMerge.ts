import type { SearchLink, SearchResult, SearchResultPayload } from '../shared/apiModels';
export function linkIdentity(link: SearchLink): string { return link.linkKey; }
function mergeSameResult(current: SearchResult, incoming: SearchResult): SearchResult {
  // Keep references and their links as one indivisible authorization snapshot.
  return { ...incoming, id: current.id, name: current.name,
    description: incoming.description || current.description };
}
export function mergeResultsByLink(results: (SearchResult | SearchResultPayload)[]): SearchResult[] {
  const buckets = new Map<string, SearchResult>();
  for (const item of results) {
    const result: SearchResult = {
      ...item,
      id: ('id' in item && item.id) || item.dedupKey || item.resultRef,
      description: item.description ?? null,
      datetime: item.datetime ?? null,
      cloud_types: ('cloud_types' in item && item.cloud_types) || [...new Set(item.links.map(link => link.type))],
      links: item.links.map(link => ({ ...link, linkKey: ('linkKey' in link && link.linkKey) || link.linkRef })),
    };
    const key = result.dedupKey || 'id:' + result.id;
    const current = buckets.get(key);
    buckets.set(key, current ? mergeSameResult(current, result) : result);
  }
  return [...buckets.values()];
}
