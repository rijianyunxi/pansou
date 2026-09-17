import { createError } from "h3";
import { resolveExternalUser } from "./externalIdentityService";
import type { UserRow } from "../../utils/userAuth";

export interface WechatMiniConfig { appId: string; secret: string }
export interface WechatIdentity { openid: string; unionId?: string }

export function validateWechatCode(code: unknown): string {
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(code)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid WeChat login code" });
  }
  return code;
}

export async function exchangeWechatCode(config: WechatMiniConfig, code: string, request: typeof fetch = fetch): Promise<WechatIdentity> {
  if (!config.appId || !config.secret) throw createError({ statusCode: 503, statusMessage: "WeChat login is not configured" });
  const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
  url.search = new URLSearchParams({ appid: config.appId, secret: config.secret, js_code: code, grant_type: "authorization_code" }).toString();
  let data: any;
  try {
    // No automatic retry: the login code is single-use. Never log this URL or source errors.
    const response = await request(url, { signal: AbortSignal.timeout(8000), redirect: "error" });
    if (!response.ok) throw new Error("source unavailable");
    data = await response.json();
  } catch {
    throw createError({ statusCode: 502, statusMessage: "WeChat login service unavailable" });
  }
  if (data?.errcode) {
    const statusCode = ({ 40029: 401, 40163: 401, 40226: 403, 45011: 429, [-1]: 503 } as Record<number, number>)[data.errcode] || 502;
    throw createError({ statusCode, statusMessage: "WeChat login failed; obtain a new login code" });
  }
  if (typeof data?.openid !== "string" || !data.openid || data.openid.length > 128 || typeof data?.session_key !== "string" || !data.session_key) {
    throw createError({ statusCode: 502, statusMessage: "Invalid WeChat login response" });
  }
  // session_key is intentionally neither persisted nor returned. This flow does not decrypt user data.
  return { openid: data.openid, unionId: typeof data.unionid === "string" ? data.unionid : undefined };
}

/**
 * Resolve the account for a WeChat mini-program identity.
 *
 * `autoProvision` is forwarded to `resolveExternalUser`; see that function for
 * why it is the only admission lever. There is no binding step.
 */
export function resolveWechatUser(
  config: WechatMiniConfig,
  identity: WechatIdentity,
  ip: string,
  options: { autoProvision?: boolean } = {},
): UserRow {
  return resolveExternalUser({ provider: "wechat-mini", providerAppId: config.appId, subject: identity.openid, unionId: identity.unionId }, ip, options);
}
