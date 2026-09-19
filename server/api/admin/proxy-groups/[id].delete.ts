import { defineEventHandler, getRouterParam } from "h3";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";
import { toHttpError } from "../../../utils/apiResponse";
import { deleteProxyGroup } from "../../../core/services/proxyRoutingService";

export default defineEventHandler((event) => {
  requireAdminAuth(event);
  try { deleteProxyGroup(String(getRouterParam(event, "id") || "")); return { code: 0, message: "deleted" }; }
  catch (error) { throw toHttpError(error, 404, "节点组不存在"); }
});
