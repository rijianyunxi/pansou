import type { SearchLink, SearchResult } from '../shared/apiModels';
export function linkIdentity(link: SearchLink): string { return link.linkKey; }
function mergeSameResult(current: SearchResult, incoming: SearchResult): SearchResult {
  // Keep references and their links as one indivisible authorization snapshot.
  return { ...incoming, id: current.id, name: current.name,
    description: incoming.description || current.description };
}
export function mergeResultsByLink(results: SearchResult[]): SearchResult[] {
  const buckets = new Map<string, SearchResult>();
  for (const result of results) {
    const key = result.dedupKey || 'id:' + result.id;
    const current = buckets.get(key);
    buckets.set(key, current ? mergeSameResult(current, result) : result);
  }
  return [...buckets.values()];
}
