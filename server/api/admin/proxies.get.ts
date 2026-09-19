import { defineEventHandler } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { listProxyNodes } from "../../core/services/proxyPoolService";
import { listProxyGroups, listProxyRoutes } from "../../core/services/proxyRoutingService";
import { listUnifiedSources } from "../../core/services/sourceCatalog";

export default defineEventHandler((event) => {
  requireAdminAuth(event);
  const nodes = listProxyNodes();
  const sources = listUnifiedSources().map((source) => ({ id: source.id, name: source.name, description: source.description, url: source.url, enabled: source.enabled !== false }));
  return { code: 0, message: "success", data: { nodes, groups: listProxyGroups(nodes), routes: listProxyRoutes(), sources } };
});
