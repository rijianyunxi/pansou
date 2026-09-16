import type { H3Event } from "h3";
import { createError } from "h3";
import {
  enforceAdminRateLimit,
  requireSameOriginAdminRequest,
} from "./adminSecurity";
import { requireUserSession } from "./userAuth";

/** Require an authenticated account with the admin role for console APIs. */
export function requireAdminAuth(event: H3Event): void {
  requireSameOriginAdminRequest(event);
  enforceAdminRateLimit(event, "admin-api", { limit: 120, windowMs: 60_000 });
  const context = requireUserSession(event, { allowMustChange: true });
  if (context.user.role !== "admin") {
    throw createError({
      statusCode: 403,
      statusMessage: "administrator role required",
    });
  }
}
