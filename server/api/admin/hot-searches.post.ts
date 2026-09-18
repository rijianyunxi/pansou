import { defineEventHandler, readBody } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { toHttpError } from "../../utils/apiResponse";
import { createAdminHotSearch } from "../../core/services/adminHotSearchService";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  try { return { code: 0, message: "created", data: { item: createAdminHotSearch(await readBody(event)) } }; }
  catch (error) { throw toHttpError(error, 400, "热门搜索词不合法"); }
});
