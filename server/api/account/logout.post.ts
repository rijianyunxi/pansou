import { defineEventHandler } from "h3";
import { requireSameOriginUserRequest } from "../../utils/userAuth";
import { getUserSession, revokeSession } from "../../utils/userAuth";
export default defineEventHandler((event) => { requireSameOriginUserRequest(event); const context = getUserSession(event, { allowMustChange: true }); revokeSession(context, event); return { ok: true }; });
