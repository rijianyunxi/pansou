import { defineEventHandler, getRouterParam } from "h3";
import { requireAdminAuth } from "../../../../utils/requireAdminAuth";
import { toHttpError } from "../../../../utils/apiResponse";
import { resetProxyNode } from "../../../../core/services/proxyPoolService";

export default defineEventHandler((event) => {
  requireAdminAuth(event);
  try {
    return {
      code: 0,
      message: "reset",
      data: { node: resetProxyNode(String(getRouterParam(event, "id") || "")) },
    };
  } catch (error) {
    throw toHttpError(error, 404, "代理节点不存在");
  }
});
