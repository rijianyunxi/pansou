import type { Link, SearchResult } from "../types/models";

/**
 * Identity of a single cloud-drive link.
 *
 * Two results may carry the same share link under different result ids, so every
 * stage of the pipeline — the streamed delta filter, the per-source merge and the
 * final JSON merge — must agree on one definition of "already delivered". The NUL
 * separator keeps the fields unambiguous.
 */
export function linkIdentity(link: Pick<Link, "type" | "url" | "password">): string {
  return `${link.type}\u0000${link.url}\u0000${link.password ?? ""}`;
}

/**
 * Identity of a whole result. Mirrors the client-side `mergeIncremental` key so
 * the streamed view and the JSON body group results the same way.
 */
export function resultIdentity(result: SearchResult): string {
  return result.id || result.links[0]?.url || `${result.name}|${result.datetime || ""}`;
}

/**
 * Union of two results that share an identity. Mirrors `mergeResource` in
 * `composables/useSearch.ts`, which is what an SSE client does with repeated ids.
 */
export function mergeSameResult(current: SearchResult, incoming: SearchResult): SearchResult {
  const links = [...current.links];
  const seen = new Set(links.map(linkIdentity));
  for (const link of incoming.links) {
    const key = linkIdentity(link);
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(link);
  }
  const tags = [...new Set([...(current.tags ?? []), ...(incoming.tags ?? [])])];
  const images = [...new Set([...(current.images ?? []), ...(incoming.images ?? [])])];
  return {
    ...current,
    ...incoming,
    links,
    cloud_types: [...new Set([...current.cloud_types, ...incoming.cloud_types])],
    description: incoming.description || current.description,
    datetime: incoming.datetime || current.datetime,
    ...(tags.length ? { tags } : {}),
    ...(images.length ? { images } : {}),
  };
}

/**
 * Claim every share link for the first result that carries it.
 *
 * A result keeps only the links no earlier result has claimed; when all of its
 * links are already claimed the result disappears. This is exactly what
 * `createDeltaFilter` does per delta in `server/utils/sendSearchStream.ts`, which
 * is why the streamed view and the JSON body now agree: dropping the whole result
 * on a partial link overlap (the previous behaviour) silently lost the remaining,
 * never-delivered links from the JSON response.
 */
export function dedupeLinks(results: SearchResult[]): SearchResult[] {
  const claimed = new Set<string>();
  const output: SearchResult[] = [];
  for (const result of results) {
    const freshLinks = result.links.filter((link) => {
      const key = linkIdentity(link);
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    });
    if (!freshLinks.length) continue;
    output.push(freshLinks.length === result.links.length
      ? result
      : { ...result, links: freshLinks, cloud_types: [...new Set(freshLinks.map((link) => link.type))] });
  }
  return output;
}

/**
 * The single deduplication definition for the whole search pipeline: results that
 * share an identity are merged, then every share link is claimed once, first
 * appearance winning. Order is the order of first appearance.
 */
export function mergeResultsByIdentity(results: SearchResult[]): SearchResult[] {
  const byId = new Map<string, SearchResult>();
  for (const result of results) {
    const key = resultIdentity(result);
    const current = byId.get(key);
    byId.set(key, current ? mergeSameResult(current, result) : result);
  }
  return dedupeLinks([...byId.values()]);
}

/**
 * Put locally managed resources ahead of source results.
 *
 * Local resources are authoritative: they are prepended, so they claim their
 * links first and any source result carrying one of those links loses just that
 * link — not the whole result.
 */
export function mergeLocalResources(
  localResults: SearchResult[],
  sourceResults: SearchResult[],
): SearchResult[] {
  return mergeResultsByIdentity([...localResults, ...sourceResults]);
}
