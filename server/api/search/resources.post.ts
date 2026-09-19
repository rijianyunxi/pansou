import { defineEventHandler, readBody } from "h3";
import { captureManagedResource } from "../../core/services/managedResourceService";
import { requireSameOriginUserRequest, getUserSession } from "../../utils/userAuth";

/** Capture a resource selected by a user into the administrator review queue. */
export default defineEventHandler(async (event) => {
  requireSameOriginUserRequest(event);
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
