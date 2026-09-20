import { createError, defineEventHandler, readBody } from "h3";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";
import { createResourceTransferJob, processResourceTransferJob, type TransferProvider } from "../../../core/services/resourceTransferService";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const body = await readBody<{ resourceId?: unknown; linkIndex?: unknown; provider?: unknown; targetFolder?: unknown }>(event);
  if (typeof body?.resourceId !== "string" || !body.resourceId.trim()) throw createError({ statusCode: 400, statusMessage: "resourceId 不合法" });
  const linkIndex = Number(body.linkIndex);
  if (!Number.isInteger(linkIndex) || linkIndex < 0) throw createError({ statusCode: 400, statusMessage: "linkIndex 不合法" });
  if (body.provider !== "quark" && body.provider !== "baidu") throw createError({ statusCode: 400, statusMessage: "仅支持夸克和百度网盘" });
  try {
    const job = createResourceTransferJob({ resourceId: body.resourceId, linkIndex, provider: body.provider as TransferProvider, targetFolder: body.targetFolder });
    void processResourceTransferJob(job.id);
    return { code: 0, message: "queued", data: { job } };
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : "无法创建转存任务" });
  }
});
