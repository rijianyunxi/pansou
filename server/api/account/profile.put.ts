import { defineEventHandler, readBody } from "h3";
import { getSqliteDatabase } from "../../core/storage/sqlite";
import { setPrivateNoStore } from "../../utils/apiResponse";
import { publicUser, requireSameOriginUserRequest, requireUserSession, validateNickname, type UserRow } from "../../utils/userAuth";

export default defineEventHandler(async (event) => {
  requireSameOriginUserRequest(event);
  setPrivateNoStore(event);
  const context = requireUserSession(event);
  const body = await readBody<{ nickname?: unknown }>(event);
  const nickname = validateNickname(body?.nickname);
  getSqliteDatabase().run("UPDATE users SET nickname = ?, updated_at = ? WHERE id = ?", nickname, Date.now(), context.user.id);
  const user = getSqliteDatabase().getRow<UserRow>("SELECT * FROM users WHERE id = ?", context.user.id)!;
  return { ok: true, user: publicUser(user) };
});
