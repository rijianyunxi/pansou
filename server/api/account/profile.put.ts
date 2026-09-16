import { defineEventHandler, readBody } from "h3";
import { getSqliteDatabase } from "../../core/storage/sqlite";
import { publicUser, requireSameOriginUserRequest, requireUserSession, validateNickname } from "../../utils/userAuth";
export default defineEventHandler(async (event) => { requireSameOriginUserRequest(event); const context = requireUserSession(event); const body = await readBody<{ nickname?: unknown }>(event); const nickname = validateNickname(body?.nickname); const timestamp = Date.now(); getSqliteDatabase().run("UPDATE users SET nickname = ?, updated_at = ? WHERE id = ?", nickname, timestamp, context.user.id); const user = getSqliteDatabase().getRow<any>("SELECT * FROM users WHERE id = ?", context.user.id)!; return { ok: true, user: publicUser(user) }; });
