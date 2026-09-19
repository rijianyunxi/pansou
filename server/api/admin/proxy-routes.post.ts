import { defineEventHandler, readBody } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { toHttpError } from "../../utils/apiResponse";
import { createProxyRoute } from "../../core/services/proxyRoutingService";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  try { return { code: 0, message: "created", data: { route: createProxyRoute(await readBody(event)) } }; }
  catch (error) { throw toHttpError(error, 400, "路由规则配置不合法"); }
});
