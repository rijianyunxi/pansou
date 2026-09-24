import { createError, defineEventHandler, getHeader, readBody, setHeader } from "h3";
import { captureManagedResource } from "../../core/services/managedResourceService";
import { MemoryRateLimiter } from "../../core/security/rateLimit";
import { getClientIp } from "../../utils/clientIp";
import { requireSameOriginUserRequest, getUserSession } from "../../utils/userAuth";

const CAPTURE_LIMIT = 60;
const CAPTURE_WINDOW_MS = 60_000;
const MAX_CAPTURE_BODY_BYTES = 256 * 1024;
const captureLimiter = new MemoryRateLimiter();

/** Capture a resource selected by a user into the administrator review queue. */
export default defineEventHandler(async (event) => {
  requireSameOriginUserRequest(event);
  const contentLength = Number(getHeader(event, "content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_CAPTURE_BODY_BYTES) {
    throw createError({ statusCode: 413, statusMessage: "资源数据过大" });
  }
  const decision = captureLimiter.check(`resource-capture:${getClientIp(event)}`, {
    limit: CAPTURE_LIMIT,
    windowMs: CAPTURE_WINDOW_MS,
  });
  setHeader(event, "X-RateLimit-Remaining", String(decision.remaining));
  if (!decision.allowed) {
    setHeader(event, "Retry-After", Math.max(1, Math.ceil(decision.retryAfterMs / 1000)));
    throw createError({ statusCode: 429, statusMessage: "资源采集过于频繁，请稍后重试" });
  }
  // Anonymous captures are allowed, matching web visitors who already capture
  // through their anonymous cookie session. Native mini program clients have
  // no persistent cookie jar, so a tokenless request gets a throwaway
  // anonymous session instead of a 401 — this endpoint stays best effort.
  getUserSession(event, { createAnonymous: true });
  try {
    const result = captureManagedResource((await readBody<Record<string, unknown>>(event)).resource);
    return { code: 0, message: result.status, data: result };
  } catch {
    // A capture failure must never affect copying or opening the original link.
    return { code: 0, message: "ignored" };
  }
});
