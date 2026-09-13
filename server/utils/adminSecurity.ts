import type { H3Event } from "h3";
import {
  createError,
  getHeader,
  getMethod,
  getRequestIP,
  setHeader,
} from "h3";
import {
  adminRateLimiter,
  type RateLimitOptions,
} from "../core/security/rateLimit";

import { isAllowedAdminOrigin } from "../core/security/adminOrigin";

// e2e 套件的每个用例都会独立登录，生产限额（如 admin-unlock 10 次/15 分钟）
// 会误伤后续用例；仅在显式设置 PANHUB_E2E=1（playwright webServer）时放大，
// 生产环境不设置该变量，行为不变。
const E2E_RATE_LIMIT_MULTIPLIER = process.env.PANHUB_E2E === "1" ? 100 : 1;

export function requireSameOriginAdminRequest(event: H3Event): void {
  if (
    !isAllowedAdminOrigin({
      method: getMethod(event),
      host: getHeader(event, "host"),
      origin: getHeader(event, "origin"),
      secFetchSite: getHeader(event, "sec-fetch-site"),
    })
  ) {
    throw createError({
      statusCode: 403,
      statusMessage: "cross-origin admin request denied",
    });
  }
}

export function enforceAdminRateLimit(
  event: H3Event,
  scope: string,
  options: RateLimitOptions
): void {
  const address =
    getHeader(event, "cf-connecting-ip") || getRequestIP(event) || "unknown";
  const decision = adminRateLimiter.check(`${scope}:${address}`, {
    ...options,
    limit: options.limit * E2E_RATE_LIMIT_MULTIPLIER,
  });
  setHeader(event, "X-RateLimit-Remaining", String(decision.remaining));
  if (!decision.allowed) {
    setHeader(
      event,
      "Retry-After",
      Math.max(1, Math.ceil(decision.retryAfterMs / 1000))
    );
    throw createError({
      statusCode: 429,
      statusMessage: "too many admin requests",
    });
  }
}
