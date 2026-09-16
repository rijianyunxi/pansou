import { defineEventHandler, getRouterParam, setHeader } from "h3";
import { requireAdminAuth } from "../../../../utils/requireAdminAuth";
import { parseUserId, revokeAdminUserSessions } from "../../../../core/services/adminUserService";

export default defineEventHandler((event) => {
  requireAdminAuth(event);
  const result = revokeAdminUserSessions(parseUserId(getRouterParam(event, "id")));
  setHeader(event, "Cache-Control", "no-store");
  return { code: 0, message: "sessions revoked", data: result };
});