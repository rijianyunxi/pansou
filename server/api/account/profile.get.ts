import { defineEventHandler, setHeader } from "h3";
import { publicUser, requireUserSession } from "../../utils/userAuth";
export default defineEventHandler((event) => { const context = requireUserSession(event, { allowMustChange: true }); setHeader(event, "Cache-Control", "no-store"); return { user: publicUser(context.user) }; });
