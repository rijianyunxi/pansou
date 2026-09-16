import { createError, defineEventHandler, readBody } from "h3";
import { getSqliteDatabase } from "../../core/storage/sqlite";
import { getUserPolicy } from "../../core/services/policyService";
import { getUserSession, hashPassword, publicUser, requireSameOriginUserRequest, rotateSession, validateNickname, validatePassword, validateUsername } from "../../utils/userAuth";
export default defineEventHandler(async (event) => {
  requireSameOriginUserRequest(event);
  if (!getUserPolicy().registrationEnabled) throw createError({ statusCode: 403, statusMessage: "��ǰδ����ע��" });
  const body = await readBody<{ username?: unknown; password?: unknown; nickname?: unknown }>(event);
  const username = validateUsername(body?.username); const password = validatePassword(body?.password); const nickname = validateNickname(body?.nickname);
  const db = getSqliteDatabase(); const timestamp = Date.now();
  try {
    const result = db.run("INSERT INTO users(username,username_normalized,password_hash,nickname,status,must_change_password,custom_channels_json,custom_channels_updated_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", username, username.toLowerCase(), hashPassword(password), nickname, "active", 0, "[]", timestamp, timestamp, timestamp);
    const user = db.getRow<any>("SELECT * FROM users WHERE id = ?", result.lastInsertRowid as number)!;
    const existing = getUserSession(event, { createAnonymous: true, allowMustChange: true });
    rotateSession(existing, event, user);
    return { ok: true, user: publicUser(user) };
  } catch (error: any) {
    if (String(error?.code).includes("SQLITE_CONSTRAINT")) throw createError({ statusCode: 409, statusMessage: "�û����Ѵ���" });
    throw error;
  }
});
