import { createHash, timingSafeEqual } from "node:crypto";
import { createError, readBody } from "h3";
import { createAuthToken, setAdminAuthCookie } from "../../utils/auth";
import {
  enforceAdminRateLimit,
  requireSameOriginAdminRequest,
} from "../../utils/adminSecurity";

function hash(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export default defineEventHandler(async (event) => {
  requireSameOriginAdminRequest(event);
  enforceAdminRateLimit(event, "admin-unlock", {
    limit: 10,
    windowMs: 15 * 60_000,
  });
  const config = useRuntimeConfig();
  const password = String(config.adminPassword || "").trim();
  if (!password) {
    throw createError({
      statusCode: 503,
      statusMessage: "admin authentication is not configured",
    });
  }
  const body = await readBody<{ password?: string }>(event);
  const input = (body?.password || "").trim();
  if (!input) {
    throw createError({ statusCode: 400, statusMessage: "password required" });
  }
  const inputHash = hash(input);
  const secretHash = hash(password);
  if (
    inputHash.length !== secretHash.length ||
    !timingSafeEqual(inputHash, secretHash)
  ) {
    throw createError({ statusCode: 401, statusMessage: "invalid password" });
  }
  setAdminAuthCookie(event, createAuthToken(password));
  return { ok: true };
});
