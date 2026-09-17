import { defineEventHandler, readBody } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { deleteAdminSearchLogs } from "../../core/services/adminSearchLogService";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const body = await readBody<{ ids?: unknown }>(event).catch(() => null);
  const ids = body && Array.isArray(body.ids) ? body.ids : [];
  return { code: 0, message: "deleted", data: deleteAdminSearchLogs(ids) };
});
