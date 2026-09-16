import { defineEventHandler, getRouterParam, setHeader } from "h3";
import { requireAdminAuth } from "../../../../../utils/requireAdminAuth";
import { deleteAdminUserChannel, parseUserId } from "../../../../../core/services/adminUserService";

export default defineEventHandler((event) => {
  requireAdminAuth(event);
  const data = deleteAdminUserChannel(parseUserId(getRouterParam(event, "id")), String(getRouterParam(event, "channel") || ""));
  setHeader(event, "Cache-Control", "no-store");
  return { code: 0, message: "deleted", data };
});