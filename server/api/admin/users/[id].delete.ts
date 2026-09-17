import { defineEventHandler, getRouterParam } from "h3";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";
import { deleteAdminUser, parseUserId } from "../../../core/services/adminUserService";

export default defineEventHandler((event) => {
  requireAdminAuth(event);
  return { code: 0, message: "soft deleted", data: deleteAdminUser(parseUserId(getRouterParam(event, "id"))) };
});
