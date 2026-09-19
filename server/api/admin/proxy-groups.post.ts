import { defineEventHandler, readBody } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { toHttpError } from "../../utils/apiResponse";
import { createProxyGroup } from "../../core/services/proxyRoutingService";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  try { return { code: 0, message: "created", data: { group: createProxyGroup(await readBody(event)) } }; }
  catch (error) { throw toHttpError(error, 400, "节点组配置不合法"); }
});
