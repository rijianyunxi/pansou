import { defineEventHandler, getRouterParam, readBody } from "h3";
import { requireAdminAuth } from "../../../../utils/requireAdminAuth";
import { deleteAdminUserChannel, parseUserId } from "../../../../core/services/adminUserService";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const body = await readBody<{ channel?: unknown }>(event).catch(() => null);
  const channel = typeof body?.channel === "string" ? body.channel : "";
  return {
    code: 0,
    message: "deleted",
    data: deleteAdminUserChannel(parseUserId(getRouterParam(event, "id")), channel),
  };
});
