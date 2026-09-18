import { defineEventHandler, readBody } from "h3";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";
import { toHttpError } from "../../../utils/apiResponse";
import { setAdminHotSearchStatus } from "../../../core/services/adminHotSearchService";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  try {
    const body = await readBody<{ terms?: unknown; status?: unknown }>(event);
    if (!Array.isArray(body?.terms) || body.terms.some((term) => typeof term !== "string")) throw new Error("terms 必须是字符串数组");
    return { code: 0, message: "updated", data: { count: setAdminHotSearchStatus(body.terms, String(body.status || "") as never) } };
  } catch (error) { throw toHttpError(error, 400, "热门搜索状态不合法"); }
});
