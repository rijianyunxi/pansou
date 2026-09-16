import { createError, defineEventHandler, readBody } from "h3";
import { getSqliteDatabase } from "../../core/storage/sqlite";
import { getUserPolicy } from "../../core/services/policyService";
import { createRandomUserId, getUserSession, hashPassword, publicUser, requireSameOriginUserRequest, rotateSession, validateNickname, validatePassword, validateUsername } from "../../utils/userAuth";
import { getClientIp } from "../../utils/clientIp";
export default defineEventHandler(async (event) => {
  requireSameOriginUserRequest(event);
  if (!getUserPolicy().registrationEnabled) throw createError({ statusCode: 403, statusMessage: "当前未开启注册" });
  const body = await readBody<{ username?: unknown; password?: unknown; nickname?: unknown }>(event);
  const username = validateUsername(body?.username); const password = validatePassword(body?.password); const nickname = validateNickname(body?.nickname);
  const db = getSqliteDatabase(); const timestamp = Date.now();
  try {
    const userId = createRandomUserId();
    const lastLoginIp = getClientIp(event);
    db.run("INSERT INTO users(id,username,username_normalized,password_hash,nickname,role,status,must_change_password,custom_channels_json,custom_channels_updated_at,last_login_ip,last_login_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", userId, username, username.toLowerCase(), hashPassword(password), nickname, "user", "active", 0, "[]", timestamp, lastLoginIp, null, timestamp, timestamp);
    const user = db.getRow<any>("SELECT * FROM users WHERE id = ?", userId)!;
    const existing = getUserSession(event, { createAnonymous: true, allowMustChange: true });
    rotateSession(existing, event, user);
    return { ok: true, user: publicUser(user) };
  } catch (error: any) {
    if (String(error?.code).includes("SQLITE_CONSTRAINT")) throw createError({ statusCode: 409, statusMessage: "用户名已存在" });
    throw error;
  }
});
