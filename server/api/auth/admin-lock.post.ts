import { clearAdminAuthCookie } from "../../utils/auth";
import {
  enforceAdminRateLimit,
  requireSameOriginAdminRequest,
} from "../../utils/adminSecurity";

export default defineEventHandler((event) => {
  requireSameOriginAdminRequest(event);
  enforceAdminRateLimit(event, "admin-lock", { limit: 20, windowMs: 60_000 });
  clearAdminAuthCookie(event);
  return { ok: true };
});
