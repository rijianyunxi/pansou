import { defineEventHandler, getQuery, getRouterParam, setHeader } from "h3";
import { requireAdminAuth } from "../../../../utils/requireAdminAuth";
import { listAdminSearchLogs } from "../../../../core/services/adminSearchLogService";
import { parseUserId } from "../../../../core/services/adminUserService";
import { positiveInteger, optionalInteger } from "../../../../core/services/adminQueryHelpers";

export default defineEventHandler((event) => {
  requireAdminAuth(event);
  const query = getQuery(event);
  const userId = parseUserId(getRouterParam(event, "id"));
  const from = optionalInteger(query.from ?? query.startTime, "from");
  const to = optionalInteger(query.to ?? query.endTime, "to");
  const page = positiveInteger(query.page, 1, 1000000);
  const pageSize = positiveInteger(query.pageSize ?? query.limit, 20, 100);
  setHeader(event, "Cache-Control", "no-store");
  return { code: 0, message: "success", data: listAdminSearchLogs({ page, pageSize, userId, keyword: String(query.keyword || query.q || ""), sessionId: optionalInteger(query.sessionId, "sessionId"), ip: String(query.ip || ""), searchScope: String(query.searchScope || query.scope || ""), from, to }) };
});
