function linkIdentity(link) { return link.linkKey; }
function mergeSameResult(current, incoming) {
  return { ...incoming, id: current.id, name: current.name,
    description: incoming.description || current.description };
}
function mergeResultsByLink(results) {
  const buckets = new Map();
  for (const result of results || []) {
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
