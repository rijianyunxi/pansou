import { defineEventHandler, getRouterParam, setHeader } from "h3";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";
import { deleteAdminUser, parseUserId } from "../../../core/services/adminUserService";

export default defineEventHandler((event) => {
  requireAdminAuth(event);
  const data = deleteAdminUser(parseUserId(getRouterParam(event, "id")));
  setHeader(event, "Cache-Control", "no-store");
  return { code: 0, message: "soft deleted", data };
});
