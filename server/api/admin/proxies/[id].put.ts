import { defineEventHandler, getRouterParam, readBody } from "h3";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";
import { toHttpError } from "../../../utils/apiResponse";
import { updateProxyNode } from "../../../core/services/proxyPoolService";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  try {
    return {
      code: 0,
      message: "updated",
      data: { node: updateProxyNode(String(getRouterParam(event, "id") || ""), await readBody(event)) },
    };
  } catch (error) {
    throw toHttpError(error, 400, "代理节点配置不合法");
  }
});
