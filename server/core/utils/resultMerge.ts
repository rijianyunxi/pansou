import type { Link, SearchResult } from "../types/models";

/** Normalize only URL spelling differences; the URL remains the sole identity. */
function canonicalLinkUrl(value: string): string {
  const raw = value.trim();
  if (!raw) return raw;
  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
    return parsed.toString();
  } catch {
    return raw;
  }
}

/**
 * Identity of a single cloud-drive link.
 *
 * Result ids are intentionally ignored: source ids are not globally reliable.
 * A password is metadata for the share URL, not part of its identity.
 */
export function linkIdentity(link: Pick<Link, "url">): string {
  return canonicalLinkUrl(link.url);
}

/**
 * Union of two results that share one or more link identities.
 */
export function mergeSameResult(current: SearchResult, incoming: SearchResult): SearchResult {
  const links: Link[] = [];
  const byLink = new Map<string, Link>();
  for (const link of [...current.links, ...incoming.links]) {
    const key = linkIdentity(link);
    const existing = byLink.get(key);
    if (existing) {
      if (!existing.password && link.password) existing.password = link.password;
      continue;
    }
    const copy = { ...link };
    byLink.set(key, copy);
    links.push(copy);
  }
  const tags = [...new Set([...(current.tags ?? []), ...(incoming.tags ?? [])])];
  const images = [...new Set([...(current.images ?? []), ...(incoming.images ?? [])])];
  return {
    ...current,
    ...incoming,
    id: current.id,
    name: current.name,
    links,
    cloud_types: [...new Set([...current.cloud_types, ...incoming.cloud_types])],
    description: incoming.description || current.description,
    datetime: incoming.datetime || current.datetime,
    ...(tags.length ? { tags } : {}),
    ...(images.length ? { images } : {}),
  };
}

/**
 * Merge results by shared links in O(results + links) amortized time.
 *
 * A result with multiple links can bridge two existing groups, so a small union-
 * find structure is used before materializing the merged result buckets. This
 * keeps link identity as the only merge rule without nested result comparisons.
 */
export function mergeResultsByLink(results: SearchResult[]): SearchResult[] {
  if (!results.length) return results;
  const parent = results.map((_result, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[index] !== index) {
      const next = parent[index]!;
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const a = find(left); const b = find(right);
    if (a === b) return;
    // Keep the earliest result as the stable bucket representative.
    if (a < b) parent[b] = a;
    else parent[a] = b;
  };
  const ownerByLink = new Map<string, number>();
  results.forEach((result, index) => {
    for (const link of result.links) {
      const key = linkIdentity(link);
      const owner = ownerByLink.get(key);
      if (owner === undefined) ownerByLink.set(key, index);
      else union(owner, index);
    }
  });

  const buckets = new Map<number, SearchResult>();
  results.forEach((result, index) => {
    const root = find(index);
    const current = buckets.get(root);
    buckets.set(root, current ? mergeSameResult(current, result) : result);
  });
  return [...buckets.values()];
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
  return mergeResultsByLink([...localResults, ...sourceResults]);
}
