import { defineEventHandler, readBody } from "h3";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";
import { toHttpError } from "../../../utils/apiResponse";
import { setAdminHotSearchPinned } from "../../../core/services/adminHotSearchService";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  try {
    const body = await readBody<{ terms?: unknown; pinned?: unknown }>(event);
    if (!Array.isArray(body?.terms) || body.terms.some((term) => typeof term !== "string") || typeof body.pinned !== "boolean") throw new Error("terms 或 pinned 参数不合法");
    return { code: 0, message: "updated", data: { count: setAdminHotSearchPinned(body.terms, body.pinned) } };
  } catch (error) { throw toHttpError(error, 400, "热门搜索置顶状态不合法"); }
});
