import { defineEventHandler, getRouterParam } from "h3";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";
import { toHttpError } from "../../../utils/apiResponse";
import { deleteProxyNode } from "../../../core/services/proxyPoolService";

export default defineEventHandler((event) => {
  requireAdminAuth(event);
  try {
    deleteProxyNode(String(getRouterParam(event, "id") || ""));
    return { code: 0, message: "deleted" };
  } catch (error) {
    throw toHttpError(error, 404, "代理节点不存在");
  }
});
