import { defineEventHandler, getRouterParam, setHeader } from "h3";
import { requireAdminAuth } from "../../../../utils/requireAdminAuth";
import { parseUserId, setAdminUserStatus } from "../../../../core/services/adminUserService";

export default defineEventHandler((event) => {
  requireAdminAuth(event);
  setHeader(event, "Cache-Control", "no-store");
  const user = setAdminUserStatus(parseUserId(getRouterParam(event, "id")), "disabled");
  return { code: 0, message: "disabled", data: { user } };
});