import { defineEventHandler, getQuery, getRouterParam } from "h3";
import { requireAdminAuth } from "../../../../utils/requireAdminAuth";
import { parseSearchLogQuery } from "../../../../utils/adminQuery";
import { listAdminSearchLogs } from "../../../../core/services/adminSearchLogService";
import { parseUserId } from "../../../../core/services/adminUserService";

/**
 * 当前无调用方：2026-09-18 孤儿接口扫描确认，仓库内没有任何地方请求本路由。
 * 全局的 GET /api/admin/search-logs 由 AdminFeaturePage.vue 使用，但按账号过滤的
 * 这一条没有入口。走 requireAdminAuth，不构成泄露风险。
 * 保留待定；若确认无用可直接删除本文件。
 */
export default defineEventHandler((event) => {
  requireAdminAuth(event);
  // The path fixes the account, so a `userId` query parameter cannot widen the scope.
  const userId = parseUserId(getRouterParam(event, "id"));
  return {
    code: 0,
    message: "success",
    data: listAdminSearchLogs(parseSearchLogQuery(getQuery(event), { userId })),
  };
});
