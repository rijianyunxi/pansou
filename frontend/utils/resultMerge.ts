import type { Link, SearchResult } from "../shared/apiModels";

/** Normalize only URL spelling differences; the URL remains the sole identity. */
function canonicalLinkUrl(value: string): string {
  const raw = value.trim();
  if (!raw) return raw;
  try {
    const parsed = new URL(raw);
    if (parsed.hostname.toLowerCase() !== "yun.139.com") parsed.hash = "";
    for (const key of ["pwd", "password", "utm_source", "utm_medium", "utm_campaign"]) parsed.searchParams.delete(key);
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

/** Merge only identical share sets. A collection must not absorb single-resource posts. */
export function mergeResultsByLink(results: SearchResult[]): SearchResult[] {
  const buckets = new Map<string, SearchResult>();
  for (const result of results) {
    const identities = [...new Set(result.links.map(linkIdentity))].sort();
    const key = identities.length ? JSON.stringify(identities) : 'id:' + result.id;
    const current = buckets.get(key);
    buckets.set(key, current ? mergeSameResult(current, result) : result);
  }
  return [...buckets.values()];
}

/**
 * Put locally managed resources ahead of source results.
 *
 * Local resources are authoritative: they are prepended, so they claim their
 * identical share sets first. Partially overlapping sets remain independent.
 */
export function mergeLocalResources(
  localResults: SearchResult[],
  sourceResults: SearchResult[],
): SearchResult[] {
  return mergeResultsByLink([...localResults, ...sourceResults]);
}
