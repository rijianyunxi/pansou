import { defineEventHandler, readBody } from "h3";
import { captureManagedResource } from "../../core/services/managedResourceService";
import { requireSameOriginUserRequest, getUserSession } from "../../utils/userAuth";

/** Capture a resource selected by a user into the administrator review queue. */
export default defineEventHandler(async (event) => {
  requireSameOriginUserRequest(event);
  getUserSession(event);
  try {
    const result = captureManagedResource((await readBody<Record<string, unknown>>(event)).resource);
    return { code: 0, message: result.status, data: result };
  } catch {
    // A capture failure must never affect copying or opening the original link.
    return { code: 0, message: "ignored" };
  }
});
