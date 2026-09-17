import { createError, defineEventHandler, readBody } from "h3";
import { getSqliteDatabase } from "../../core/storage/sqlite";
import { setPrivateNoStore } from "../../utils/apiResponse";
import { getClientIp } from "../../utils/clientIp";
import {
  enforceCredentialLoginRateLimit,
  recordCredentialLoginFailure,
} from "../../utils/adminSecurity";
import {
  getUserSession,
  publicUser,
  requireSameOriginUserRequest,
  rotateSession,
  validateUsername,
  verifyPassword,
  type UserRow,
} from "../../utils/userAuth";

export default defineEventHandler(async (event) => {
  requireSameOriginUserRequest(event);
  setPrivateNoStore(event);
  // Gate before touching the password so guesses are actually capped. Only
  // failures are charged, so a successful sign-in never spends budget.
  enforceCredentialLoginRateLimit(event);
  const body = await readBody<{ username?: unknown; password?: unknown }>(event);
  const username = validateUsername(body?.username);
  const password = typeof body?.password === "string" ? body.password : "";
  const user = getSqliteDatabase().getRow<UserRow>("SELECT * FROM users WHERE username_normalized = ?", username.toLowerCase());
  if (!user || user.deleted_at || user.status !== "active" || !verifyPassword(password, user.password_hash)) {
    recordCredentialLoginFailure(event);
    throw createError({ statusCode: 401, statusMessage: "用户名或密码错误" });
  }
  // Only administrators sign in with a password; regular accounts use the mini program.
  if (user.role !== "admin") {
    throw createError({ statusCode: 403, statusMessage: "普通用户请使用微信小程序登录" });
  }
  const existing = getUserSession(event, { createAnonymous: true });
  const timestamp = Date.now();
  const ip = getClientIp(event);
  getSqliteDatabase().run("UPDATE users SET last_login_at = ?, last_login_ip = ?, updated_at = ? WHERE id = ?", timestamp, ip, timestamp, user.id);
  user.last_login_at = timestamp;
  user.last_login_ip = ip;
  rotateSession(existing, event, user);
  return { ok: true, user: publicUser(user) };
});
