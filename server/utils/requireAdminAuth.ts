import type { H3Event } from "h3";
import { createError } from "h3";
import { verifyAdminAuthCookie } from "./auth";
import {
  enforceAdminRateLimit,
  requireSameOriginAdminRequest,
} from "./adminSecurity";

export function requireAdminAuth(event: H3Event): void {
  requireSameOriginAdminRequest(event);
  enforceAdminRateLimit(event, "admin-api", { limit: 120, windowMs: 60_000 });
  const config = useRuntimeConfig();
  const password = String((config as any).adminPassword || "").trim();
  if (!password) {
    throw createError({
      statusCode: 503,
      statusMessage: "admin authentication is not configured",
    });
  }
  if (!verifyAdminAuthCookie(event, password)) {
    throw createError({
      statusCode: 401,
      statusMessage: "admin authentication required",
    });
  }
}
