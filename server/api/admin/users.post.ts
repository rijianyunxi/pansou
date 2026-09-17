import { defineEventHandler, readBody } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { createAdminUser } from "../../core/services/adminUserService";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const body = await readBody<{ username?: unknown; password?: unknown; nickname?: unknown }>(event);
  return { code: 0, message: "created", data: { user: createAdminUser({ username: body?.username, password: body?.password, nickname: body?.nickname }) } };
});
