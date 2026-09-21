import { defineEventHandler, readBody } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { baiduAccountSettingsView, saveBaiduCookie } from "../../core/services/cloudAccountService";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const body = await readBody<{ cookie?: unknown }>(event);
  const value = body && Object.prototype.hasOwnProperty.call(body, "cookie") ? body.cookie : undefined;
  if (value === undefined) return { code: 0, message: "success", data: baiduAccountSettingsView() };
  return { code: 0, message: "success", data: saveBaiduCookie(value) };
});
