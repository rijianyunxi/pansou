import { defineEventHandler, getRouterParam } from "h3";
import { requireAdminAuth } from "../../../../utils/requireAdminAuth";
import { getAdminUserChannels, parseUserId } from "../../../../core/services/adminUserService";

export default defineEventHandler((event) => {
  requireAdminAuth(event);
  return { code: 0, message: "success", data: getAdminUserChannels(parseUserId(getRouterParam(event, "id"))) };
});