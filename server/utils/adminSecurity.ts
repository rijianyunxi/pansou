import { createError, getHeader, getMethod, setHeader, type H3Event } from "h3";
import { adminRateLimiter, credentialLoginLimiter, type RateLimitOptions } from "../core/security/rateLimit";
import { isAllowedAdminOrigin } from "../core/security/adminOrigin";
import { getClientIp } from "./clientIp";

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
  const address = getClientIp(event);
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

const CREDENTIAL_LOGIN_LIMIT = 10;
const CREDENTIAL_LOGIN_WINDOW_MS = 60_000;

function credentialLoginOptions(): RateLimitOptions {
  return {
    limit: CREDENTIAL_LOGIN_LIMIT,
    windowMs: CREDENTIAL_LOGIN_WINDOW_MS,
  };
}

function credentialLoginKey(event: H3Event): string {
  return `credential-login:${getClientIp(event)}`;
}

/**
 * Refuse a password sign-in once the failure budget for this caller is spent.
 *
 * This is the only password-guessing surface in the system — ordinary accounts
 * have no password entry point — so it is throttled separately from the console
 * budget, which must stay usable for an already-signed-in administrator.
 *
 * Only failures are charged (see `recordCredentialLoginFailure`), so repeatedly
 * signing in successfully never spends budget.
 *
 * CAVEAT: the bucket is keyed by `getClientIp`, which returns the *socket*
 * address unless `trustProxy` is on. Behind a reverse proxy with `trustProxy`
 * off, every caller therefore shares one bucket: guessing is still capped, but
 * an attacker can also exhaust it and deny the real administrator's sign-in
 * (they gain no access). Set `NUXT_TRUST_PROXY=true` to make the limit per-IP.
 */
export function enforceCredentialLoginRateLimit(event: H3Event): void {
  const decision = credentialLoginLimiter.peek(credentialLoginKey(event), credentialLoginOptions());
  setHeader(event, "X-RateLimit-Remaining", String(decision.remaining));
  if (decision.allowed) return;
  setHeader(
    event,
    "Retry-After",
    Math.max(1, Math.ceil(decision.retryAfterMs / 1000))
  );
  throw createError({
    statusCode: 429,
    statusMessage: "登录尝试过于频繁，请稍后再试",
  });
}

/** Charge one failed sign-in against the caller's budget. */
export function recordCredentialLoginFailure(event: H3Event): void {
  credentialLoginLimiter.check(credentialLoginKey(event), credentialLoginOptions());
}
