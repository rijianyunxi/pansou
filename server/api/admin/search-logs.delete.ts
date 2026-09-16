import { defineEventHandler, readBody, setHeader } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { deleteAdminSearchLogs } from "../../core/services/adminSearchLogService";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const body = await readBody<{ ids?: unknown }>(event).catch(() => null);
  const ids = body && Array.isArray(body.ids) ? body.ids : [];
  const data = deleteAdminSearchLogs(ids);
  setHeader(event, "Cache-Control", "no-store");
  return { code: 0, message: "deleted", data };
});
