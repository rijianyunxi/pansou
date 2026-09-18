import { defineEventHandler } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { listProxyNodes } from "../../core/services/proxyPoolService";

export default defineEventHandler((event) => {
  requireAdminAuth(event);
  return { code: 0, message: "success", data: { nodes: listProxyNodes() } };
});
