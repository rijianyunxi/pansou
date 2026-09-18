import { createError, defineEventHandler, getRouterParam } from "h3";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";
import { deleteAdminHotSearch } from "../../../core/services/adminHotSearchService";

export default defineEventHandler((event) => {
  requireAdminAuth(event);
  const term = String(getRouterParam(event, "term") || "");
  if (!term) throw createError({ statusCode: 400, statusMessage: "热门搜索词不能为空" });
  if (!deleteAdminHotSearch([term])) throw createError({ statusCode: 404, statusMessage: "热门搜索词不存在" });
  return { code: 0, message: "deleted", data: null };
});
