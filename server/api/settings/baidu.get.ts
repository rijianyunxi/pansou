import { defineEventHandler } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { baiduAccountSettingsView } from "../../core/services/cloudAccountService";

export default defineEventHandler((event) => {
  requireAdminAuth(event);
  return { code: 0, message: "success", data: baiduAccountSettingsView() };
});
