function linkIdentity(link) { return link.linkKey; }
function mergeSameResult(current, incoming) {
  return { ...incoming, id: current.id, name: current.name,
    description: incoming.description || current.description };
}
function mergeResultsByLink(results) {
  const buckets = new Map();
  for (const item of results || []) {
    const result = { ...item, id: item.id || item.dedupKey || item.resultRef,
      cloud_types: item.cloud_types || Array.from(new Set((item.links || []).map(link => link.type))),
      links: (item.links || []).map(link => ({ ...link, linkKey: link.linkKey || link.linkRef })),
    };
    const key = result.dedupKey || 'id:' + result.id;
    const current = buckets.get(key);
    buckets.set(key, current ? mergeSameResult(current, result) : result);
  }
  return Array.from(buckets.values());
}
function flattenResultsForDisplay(results) {
  return (results || []).flatMap(resource => (resource.links || []).map((link, index) => ({
    ...resource, id: resource.resultRef + '::' + index, cloud_types: [link.type], links: [link],
  })));
}
module.exports = { linkIdentity, mergeSameResult, mergeResultsByLink, flattenResultsForDisplay };
