import { defineEventHandler, getRouterParam, readBody, setHeader } from "h3";
import { requireAdminAuth } from "../../../../utils/requireAdminAuth";
import { deleteAdminUserChannel, parseUserId } from "../../../../core/services/adminUserService";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const body: any = await readBody(event).catch(() => ({}));
  const channel = typeof body?.channel === "string" ? body.channel : "";
  const data = deleteAdminUserChannel(parseUserId(getRouterParam(event, "id")), channel);
  setHeader(event, "Cache-Control", "no-store");
  return { code: 0, message: "deleted", data };
});
