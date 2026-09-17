import { defineEventHandler, getRouterParam } from "h3";
import { requireAdminAuth } from "../../../../../utils/requireAdminAuth";
import { deleteAdminUserChannel, parseUserId } from "../../../../../core/services/adminUserService";

/**
 * 当前无调用方：2026-09-18 孤儿接口扫描确认，仓库内没有任何地方请求本路由。
 * AdminFeaturePage.vue 只调用同目录的 GET .../channels（读取频道列表），
 * 没有单条删除的入口。走 requireAdminAuth，不构成泄露风险。
 * 保留待定；若确认无用可直接删除本文件。
 */
export default defineEventHandler((event) => {
  requireAdminAuth(event);
  const data = deleteAdminUserChannel(parseUserId(getRouterParam(event, "id")), String(getRouterParam(event, "channel") || ""));
  return { code: 0, message: "deleted", data };
});