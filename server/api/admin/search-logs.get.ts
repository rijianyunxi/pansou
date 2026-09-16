import { createError, defineEventHandler, getQuery, setHeader } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { listAdminSearchLogs } from "../../core/services/adminSearchLogService";
import { positiveInteger, optionalInteger } from "../../core/services/adminQueryHelpers";

export default defineEventHandler((event) => {
  requireAdminAuth(event);
  const query = getQuery(event);
  const page = positiveInteger(query.page, 1, 1000000);
  const pageSize = positiveInteger(query.pageSize ?? query.limit, 20, 100);
  const from = optionalInteger(query.from ?? query.startTime, "from");
  const to = optionalInteger(query.to ?? query.endTime, "to");
  if (from !== undefined && to !== undefined && from > to) throw createError({ statusCode: 400, statusMessage: "invalid time range" });
  setHeader(event, "Cache-Control", "no-store");
  return { code: 0, message: "success", data: listAdminSearchLogs({ page, pageSize, keyword: String(query.keyword || query.q || ""), userId: optionalInteger(query.userId, "userId"), sessionId: optionalInteger(query.sessionId, "sessionId"), ip: String(query.ip || ""), searchScope: String(query.searchScope || query.scope || ""), from, to }) };
});