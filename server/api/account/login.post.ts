import { createError, defineEventHandler, readBody } from "h3";
import { getSqliteDatabase } from "../../core/storage/sqlite";
import { getUserSession, publicUser, requireSameOriginUserRequest, rotateSession, validateUsername } from "../../utils/userAuth";
import { verifyPassword } from "../../utils/userAuth";
import { getClientIp } from "../../utils/clientIp";
export default defineEventHandler(async (event) => {
  requireSameOriginUserRequest(event);
  const body = await readBody<{ username?: unknown; password?: unknown }>(event);
  const username = validateUsername(body?.username); const password = typeof body?.password === "string" ? body.password : "";
  const user = getSqliteDatabase().getRow<any>("SELECT * FROM users WHERE username_normalized = ?", username.toLowerCase());
  if (!user || user.deleted_at || user.status !== "active" || !verifyPassword(password, user.password_hash)) throw createError({ statusCode: 401, statusMessage: "用户名或密码错误" });
  const existing = getUserSession(event, { createAnonymous: true, allowMustChange: true });
  const timestamp = Date.now(); getSqliteDatabase().run("UPDATE users SET last_login_at = ?, last_login_ip = ?, updated_at = ? WHERE id = ?", timestamp, getClientIp(event), timestamp, user.id);
  user.last_login_at = timestamp;
  user.last_login_ip = getClientIp(event);
  rotateSession(existing, event, user);
  return { ok: true, user: publicUser(user) };
});
