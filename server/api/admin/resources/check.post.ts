import { createError, defineEventHandler, readBody } from "h3";
import { checkManagedResources } from "../../../core/services/managedResourceService";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";

/** Manually check the selected resources. This endpoint intentionally stays synchronous for the first version. */
export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const body = await readBody<{ ids?: unknown }>(event);
  if (!Array.isArray(body?.ids) || body.ids.some((id) => typeof id !== "string")) {
    throw createError({ statusCode: 400, statusMessage: "ids 必须是字符串数组" });
  }
  if (body.ids.length > 50) {
    throw createError({ statusCode: 400, statusMessage: "单次最多检测 50 条资源" });
  }
  const results = await checkManagedResources(body.ids);
  return {
    code: 0,
    message: "checked",
    data: {
      results,
      count: results.length,
      valid: results.filter((item) => item.status === "valid").length,
      invalid: results.filter((item) => item.status === "invalid").length,
      unknown: results.filter((item) => item.status === "unknown").length,
    },
  };
});
