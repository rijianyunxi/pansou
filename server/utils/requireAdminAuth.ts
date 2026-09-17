import type { H3Event } from "h3";
import { createError } from "h3";
import {
  enforceAdminRateLimit,
  requireSameOriginAdminRequest,
} from "./adminSecurity";
import { setPrivateNoStore } from "./apiResponse";
import { requireUserSession } from "./userAuth";

/**
 * Gate for every console API: same-origin check, shared admin rate limit, then
 * an authenticated account carrying the admin role.
 *
 * Every console response is per-account and reflects live configuration, so the
 * no-store policy is applied here instead of being repeated in each handler.
 *
 * The resolved session is returned so handlers that need the acting account
 * (for example /api/admin/account) do not resolve it a second time.
 */
export function requireAdminAuth(event: H3Event) {
  setPrivateNoStore(event);
  requireSameOriginAdminRequest(event);
  enforceAdminRateLimit(event, "admin-api", { limit: 120, windowMs: 60_000 });
  const context = requireUserSession(event);
  if (context.user.role !== "admin") {
    throw createError({
      statusCode: 403,
      statusMessage: "administrator role required",
    });
  }
  return context;
}
