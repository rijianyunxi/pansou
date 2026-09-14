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
  const decision = adminRateLimiter.check(`${scope}:${address}`, options);
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
