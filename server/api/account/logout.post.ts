import { defineEventHandler } from "h3";
import { setPrivateNoStore } from "../../utils/apiResponse";
import { getUserSession, requireSameOriginUserRequest, revokeSession } from "../../utils/userAuth";

export default defineEventHandler((event) => {
  requireSameOriginUserRequest(event);
  setPrivateNoStore(event);
  const context = getUserSession(event);
  revokeSession(context, event);
  return { ok: true };
});
