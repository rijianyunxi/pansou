import { defineEventHandler } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { getWechatMiniSettings, wechatMiniSettingsView } from "../../core/services/wechatConfigService";

/**
 * Current WeChat mini-program settings.
 *
 * The response is the masked view: it reports whether an AppSecret is stored
 * and how long it is, never the value itself. The console therefore has to
 * treat the secret as write-only — an empty field means "leave it alone".
 */
export default defineEventHandler((event) => {
  requireAdminAuth(event);
  return { code: 0, message: "success", data: wechatMiniSettingsView(getWechatMiniSettings()) };
});
