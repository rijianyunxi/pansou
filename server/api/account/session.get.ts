import { defineEventHandler, setHeader } from "h3";
import { getUserSession, publicUser } from "../../utils/userAuth";
import { cleanupUserData } from "../../core/services/policyService";
export default defineEventHandler((event) => { cleanupUserData(); const context = getUserSession(event, { createAnonymous: true, allowMustChange: true }); setHeader(event, "Cache-Control", "no-store"); return { authenticated: !!context.user, user: context.user ? publicUser(context.user) : null, sessionId: context.session.id }; });
