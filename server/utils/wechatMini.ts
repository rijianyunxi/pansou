import { createError, setHeader, type H3Event } from "h3";
import { MemoryRateLimiter } from "../core/security/rateLimit";
import { getWechatMiniSettings, type WechatMiniSettings } from "../core/services/wechatConfigService";
import { setPrivateNoStore } from "./apiResponse";
import { getClientIp } from "./clientIp";

const WECHAT_LOGIN_LIMIT = 20;
const WECHAT_LOGIN_WINDOW_MS = 60_000;

/**
 * Watching a code is a fast, cheap read loop — a browser polls once every two
 * seconds for up to three minutes. It gets its own budget so that watching a
 * code can never spend the attempts `prepareWechatRequest` guards.
 */
const WECHAT_QR_POLL_LIMIT = 150;
const WECHAT_QR_POLL_WINDOW_MS = 60_000;

const limiter = new MemoryRateLimiter();
const qrPollLimiter = new MemoryRateLimiter();

/**
 * Guard the WeChat endpoints: disable caching, apply a per-IP limit, then load
 * the stored credentials.
 *
 * The full settings object is returned, so a handler that also needs the code
 * page or the build channel does not read the row a second time.
 */
export function prepareWechatRequest(event: H3Event): WechatMiniSettings {
  setPrivateNoStore(event);
  const decision = limiter.check(getClientIp(event), {
    limit: WECHAT_LOGIN_LIMIT,
    windowMs: WECHAT_LOGIN_WINDOW_MS,
  });
  if (!decision.allowed) {
    setHeader(event, "Retry-After", Math.max(1, Math.ceil(decision.retryAfterMs / 1000)));
    throw createError({ statusCode: 429, statusMessage: "Too many WeChat login attempts" });
  }
  return getWechatMiniSettings();
}

/**
 * Guard the ticket-status endpoint. It is polled continuously, so it gets the
 * larger budget above and never shares a bucket with sign-in attempts.
 */
export function prepareWechatQrPollRequest(event: H3Event): void {
  setPrivateNoStore(event);
  const decision = qrPollLimiter.check(getClientIp(event), {
    limit: WECHAT_QR_POLL_LIMIT,
    windowMs: WECHAT_QR_POLL_WINDOW_MS,
  });
  if (!decision.allowed) {
    setHeader(event, "Retry-After", Math.max(1, Math.ceil(decision.retryAfterMs / 1000)));
    throw createError({ statusCode: 429, statusMessage: "Too many WeChat login polls" });
  }
}
