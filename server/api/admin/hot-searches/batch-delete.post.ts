import { createError, defineEventHandler, readBody } from "h3";
import { deleteAdminHotSearch } from "../../../core/services/adminHotSearchService";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const body = await readBody<{ terms?: unknown }>(event);
  if (!Array.isArray(body?.terms) || body.terms.some((term) => typeof term !== "string")) {
    throw createError({ statusCode: 400, statusMessage: "terms 必须是字符串数组" });
  }
  return {
    code: 0,
    message: "deleted",
    data: { count: deleteAdminHotSearch(body.terms) },
  };
});
