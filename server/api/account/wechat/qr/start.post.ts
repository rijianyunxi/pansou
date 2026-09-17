import { createError, defineEventHandler } from "h3";
import { getUserPolicy } from "../../../../core/services/policyService";
import { startWechatQrLogin } from "../../../../core/services/wechatQrLoginService";
import { getClientIp } from "../../../../utils/clientIp";
import { requireSameOriginUserRequest } from "../../../../utils/userAuth";
import { prepareWechatRequest } from "../../../../utils/wechatMini";

/**
 * Open a website sign-in: issue a ticket and return the mini-program code that
 * carries it. The browser renders the image and starts polling.
 */
export default defineEventHandler(async (event) => {
  requireSameOriginUserRequest(event);
  const settings = prepareWechatRequest(event);
  // The console switch hides the entry; it must not leave a working URL behind.
  if (!getUserPolicy().showAuthButtons) {
    throw createError({ statusCode: 403, statusMessage: "登录入口已关闭" });
  }
  const login = await startWechatQrLogin(
    settings,
    { qrPage: settings.qrPage, envVersion: settings.envVersion },
    getClientIp(event),
  );
  return { ok: true, ticket: login.ticket, qrImage: login.qrImage, expiresAt: login.expiresAt };
});
