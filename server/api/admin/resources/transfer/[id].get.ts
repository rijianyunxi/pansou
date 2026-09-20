import { createError, defineEventHandler, getRouterParam } from "h3";
import { requireAdminAuth } from "../../../../utils/requireAdminAuth";
import { getResourceTransferJob } from "../../../../core/services/resourceTransferService";

export default defineEventHandler((event) => {
  requireAdminAuth(event);
  const job = getResourceTransferJob(String(getRouterParam(event, "id") || ""));
  if (!job) throw createError({ statusCode: 404, statusMessage: "转存任务不存在" });
  return { code: 0, message: "success", data: { job } };
});
