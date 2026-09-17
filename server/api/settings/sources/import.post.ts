import { defineEventHandler, readBody } from "h3";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";
import { toHttpError } from "../../../utils/apiResponse";
import { importConfiguredSources } from "../../../core/services/sourceCatalog";

/**
 * 当前无调用方：2026-09-18 孤儿接口扫描确认，仓库内没有任何地方请求本路由，
 * 后台管理页也没有对应的导入入口。走 requireAdminAuth，不构成泄露风险。
 * 与同目录的 export.get.ts 是一对；两者都无人使用。
 * 保留待定（可能原计划用于手工运维导入）；若确认无用可直接删除本文件。
 */
export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const body = await readBody(event);
  const input = typeof body === "string" ? body : body?.file ?? body?.source ?? body;
  try {
    const data = importConfiguredSources(input, String(body?.actor || "admin").slice(0, 100));
    return { code: 0, message: "imported", data };
  } catch (error) {
    throw toHttpError(error, 400, "failed to import sources");
  }
});
