import { defineEventHandler, readBody } from "h3";
import { exchangeWechatCode, resolveWechatUser, validateWechatCode } from "../../../core/services/wechatMiniService";
import { prepareWechatRequest } from "../../../utils/wechatMini";
import { createMiniProgramSession, publicUser, requireSameOriginUserRequest } from "../../../utils/userAuth";
import { getClientIp } from "../../../utils/clientIp";

export default defineEventHandler(async (event) => {
  requireSameOriginUserRequest(event);
  const config = prepareWechatRequest(event);
  const body = await readBody<{ code?: unknown }>(event);
  const identity = await exchangeWechatCode(config, validateWechatCode(body?.code));
  // A first-time visitor gets an account here; there is no separate sign-up step.
  const user = resolveWechatUser(config, identity, getClientIp(event), { autoProvision: true });
  const context = createMiniProgramSession(event, user);
  return { ok: true, user: publicUser(user), token: context.token, tokenType: "Bearer", expiresAt: context.session.expires_at };
});
