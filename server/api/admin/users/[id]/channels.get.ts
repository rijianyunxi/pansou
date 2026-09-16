import { defineEventHandler, getRouterParam, setHeader } from "h3";
import { requireAdminAuth } from "../../../../utils/requireAdminAuth";
import { getAdminUserChannels, parseUserId } from "../../../../core/services/adminUserService";

export default defineEventHandler((event) => {
  requireAdminAuth(event);
  setHeader(event, "Cache-Control", "no-store");
  return { code: 0, message: "success", data: getAdminUserChannels(parseUserId(getRouterParam(event, "id"))) };
});