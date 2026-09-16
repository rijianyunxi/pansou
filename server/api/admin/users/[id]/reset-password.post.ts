import { defineEventHandler, getRouterParam, readBody, setHeader } from "h3";
import { requireAdminAuth } from "../../../../utils/requireAdminAuth";
import { parseUserId, resetAdminUserPassword } from "../../../../core/services/adminUserService";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const body = await readBody<{ password?: unknown; newPassword?: unknown }>(event);
  const userId = parseUserId(getRouterParam(event, "id"));
  resetAdminUserPassword(userId, body?.newPassword ?? body?.password);
  setHeader(event, "Cache-Control", "no-store");
  return { code: 0, message: "password reset", data: { userId, mustChangePassword: true } };
});