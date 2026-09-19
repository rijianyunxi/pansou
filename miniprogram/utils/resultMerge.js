/**
 * Port of server/core/utils/resultMerge.ts.
 *
 * The URL is the only merge identity. WHATWG URL is unavailable in the mini
 * program runtime, so canonicalization is done with a regex that mirrors the
 * server rules: trim, lowercase scheme + hostname, drop the hash, strip
 * trailing path slashes.
 */
function canonicalLinkUrl(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return raw;
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:)(?:\/\/([^/?#]*))?([^?#]*)(\?[^#]*)?(?:#.*)?$/.exec(raw);
  if (!match) return raw;
  const scheme = match[1].toLowerCase();
  const authority = match[2];
  let path = match[3] || '';
  const query = match[4] || '';
  let hostPart = '';
  if (authority !== undefined) {
    const atIndex = authority.lastIndexOf('@');
    const userinfo = atIndex >= 0 ? authority.slice(0, atIndex + 1) : '';
    hostPart = userinfo + authority.slice(atIndex + 1).toLowerCase();
  }
  path = path.replace(/\/+$/, '') || '/';
  return `${scheme}//${hostPart}${path}${query}`;
}

function linkIdentity(link) {
  return canonicalLinkUrl(link.url);
}

function unionOf(current, incoming) {
  const seen = {};
  const merged = [];
  const lists = [current, incoming];
  for (const list of lists) {
    if (!list) continue;
    for (const item of list) {
      if (seen[item]) continue;
      seen[item] = true;
      merged.push(item);
    }
  }
  return merged;
}

/** Union of two results that share one or more link identities. */
function mergeSameResult(current, incoming) {
  const links = [];
  const byLink = {};
  const combined = (current.links || []).concat(incoming.links || []);
  for (const link of combined) {
    const key = linkIdentity(link);
    const existing = byLink[key];
    if (existing) {
      if (!existing.password && link.password) existing.password = link.password;
      continue;
    }
    const copy = { type: link.type, url: link.url, password: link.password || null };
    byLink[key] = copy;
    links.push(copy);
  }

  const merged = {
    id: current.id,
    name: current.name,
    description: incoming.description || current.description,
    datetime: incoming.datetime || current.datetime,
    cloud_types: unionOf(current.cloud_types, incoming.cloud_types),
    links,
  };
  const tags = unionOf(current.tags, incoming.tags);
  if (tags.length) merged.tags = tags;
  const images = unionOf(current.images, incoming.images);
  if (images.length) merged.images = images;
  return merged;
}

/**
 * Merge results that share links, in O(results + links) amortized time via a
 * small union-find; the earliest result stays the bucket representative.
 */
function mergeResultsByLink(results) {
  if (!results || !results.length) return results || [];
  const parent = results.map((_result, index) => index);
  function find(index) {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  }
  function union(left, right) {
    const a = find(left);
    const b = find(right);
    if (a === b) return;
    if (a < b) parent[b] = a;
    else parent[a] = b;
  }

  const ownerByLink = {};
  results.forEach((result, index) => {
    for (const link of result.links || []) {
      const key = linkIdentity(link);
      const owner = ownerByLink[key];
      if (owner === undefined) ownerByLink[key] = index;
      else union(owner, index);
    }
  });

  const buckets = new Map();
  results.forEach((result, index) => {
    const root = find(index);
    const current = buckets.get(root);
    buckets.set(root, current ? mergeSameResult(current, result) : result);
  });
  return Array.from(buckets.values());
}

module.exports = { canonicalLinkUrl, linkIdentity, mergeSameResult, mergeResultsByLink };
