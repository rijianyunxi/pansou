import { defineEventHandler, getQuery } from "h3";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";
import { resolveProxyRoute } from "../../../core/services/proxyRoutingService";

export default defineEventHandler((event) => {
  requireAdminAuth(event);
  const sourceId = String(getQuery(event).sourceId || "").trim().toLowerCase();
  if (!sourceId) return { code: 0, message: "success", data: { sourceId, decision: undefined } };
  return { code: 0, message: "success", data: { sourceId, decision: resolveProxyRoute(sourceId) } };
});
