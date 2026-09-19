import { defineEventHandler, readBody, getRouterParam } from "h3";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";
import { toHttpError } from "../../../utils/apiResponse";
import { updateProxyRoute } from "../../../core/services/proxyRoutingService";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  try { return { code: 0, message: "updated", data: { route: updateProxyRoute(String(getRouterParam(event, "id") || ""), await readBody(event)) } }; }
  catch (error) { throw toHttpError(error, 400, "路由规则配置不合法"); }
});
