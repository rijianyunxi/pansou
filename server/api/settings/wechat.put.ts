import { defineEventHandler, readBody } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { saveWechatMiniSettings, wechatMiniSettingsView, type WechatMiniSettingsPatch } from "../../core/services/wechatConfigService";

/**
 * Update the WeChat mini-program settings.
 *
 * An omitted or blank `secret` keeps the stored one, because the console never
 * receives the current value and so cannot send it back. Validation is strict
 * here — a rejected field is reported as 400 instead of silently keeping the
 * previous value.
 */
export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const body = await readBody<WechatMiniSettingsPatch>(event);
  const saved = saveWechatMiniSettings(body && typeof body === "object" ? body : {});
  return { code: 0, message: "success", data: wechatMiniSettingsView(saved) };
});
