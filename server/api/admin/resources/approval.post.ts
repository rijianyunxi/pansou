import { createError, defineEventHandler, readBody } from "h3";
import { setManagedResourceApproval } from "../../../core/services/managedResourceService";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const body = await readBody<{ ids?: unknown; status?: unknown }>(event);
  if (!Array.isArray(body?.ids) || body.ids.some((id) => typeof id !== "string")) {
    throw createError({ statusCode: 400, statusMessage: "ids 必须是字符串数组" });
  }
  if (body.status !== "approved" && body.status !== "rejected") {
    throw createError({ statusCode: 400, statusMessage: "审核状态不合法" });
  }
  const count = setManagedResourceApproval(body.ids, body.status);
  return { code: 0, message: body.status, data: { count } };
});
