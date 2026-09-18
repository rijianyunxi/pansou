import { defineEventHandler, getRouterParam, readBody } from "h3";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";
import { toHttpError } from "../../../utils/apiResponse";
import { updateAdminHotSearch } from "../../../core/services/adminHotSearchService";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  try { return { code: 0, message: "updated", data: { item: updateAdminHotSearch(String(getRouterParam(event, "term") || ""), await readBody(event)) } }; }
  catch (error) { throw toHttpError(error, 400, "热门搜索词不合法"); }
});
