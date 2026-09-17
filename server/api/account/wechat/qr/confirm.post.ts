import { defineEventHandler, readBody } from "h3";
import { confirmWechatQrLogin, normalizeLoginTicket } from "../../../../core/services/wechatQrLoginService";
import { getClientIp } from "../../../../utils/clientIp";
import { requireSameOriginUserRequest } from "../../../../utils/userAuth";
import { prepareWechatRequest } from "../../../../utils/wechatMini";

/**
 * Confirm a scanned code from inside the mini program.
 *
 * The mini program is opened with the ticket as its code scene and posts that
 * scene back together with a fresh `wx.login` code. Resolving the account is
 * the same call the in-mini-program sign-in makes, so a first-time scanner is
 * provisioned here and a disabled account is refused.
 */
export default defineEventHandler(async (event) => {
  requireSameOriginUserRequest(event);
  const config = prepareWechatRequest(event);
  const body = await readBody<{ ticket?: unknown; scene?: unknown; code?: unknown }>(event);
  // The scene arrives verbatim on the mini-program side, so accept it under
  // either name instead of forcing every caller to rename it.
  const ticket = normalizeLoginTicket(body?.ticket ?? body?.scene);
  await confirmWechatQrLogin(config, ticket, body?.code, getClientIp(event));
  return { ok: true, status: "confirmed" };
});
