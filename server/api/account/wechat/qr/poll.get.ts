import { createError, defineEventHandler, getQuery } from "h3";
import { getUserPolicy } from "../../../../core/services/policyService";
import { consumeWechatQrLogin, getWechatQrLoginStatus, normalizeLoginTicket } from "../../../../core/services/wechatQrLoginService";
import { getSqliteDatabase } from "../../../../core/storage/sqlite";
import { getClientIp } from "../../../../utils/clientIp";
import { getUserSession, publicUser, requireSameOriginUserRequest, rotateSession, type UserRow } from "../../../../utils/userAuth";
import { prepareWechatQrPollRequest } from "../../../../utils/wechatMini";

/**
 * Ticket status, and the one place a scanned code becomes a browser session.
 *
 * A confirmation is handed over exactly once: the ticket flips to `consumed`
 * and the anonymous cookie session is rotated into the account, so the browser
 * ends up holding the same kind of session a password sign-in produces. Every
 * other answer is a status, not an error — a poll asks, it does not command.
 */
export default defineEventHandler((event) => {
  requireSameOriginUserRequest(event);
  prepareWechatQrPollRequest(event);
  if (!getUserPolicy().showAuthButtons) {
    throw createError({ statusCode: 403, statusMessage: "登录入口已关闭" });
  }
  const ticket = normalizeLoginTicket(getQuery(event)?.ticket);
  const userId = consumeWechatQrLogin(ticket);
  // Not a fresh confirmation. A ticket another tab already consumed also lands
  // here; that tab shares this cookie jar and reports `confirmed`, so the client
  // re-reads the session rather than treating the empty payload as a failure.
  if (userId === undefined) return { ok: true, status: getWechatQrLoginStatus(ticket), user: null };

  const user = getSqliteDatabase().getRow<UserRow>("SELECT * FROM users WHERE id = ?", userId);
  if (!user || user.deleted_at || user.status !== "active") {
    throw createError({ statusCode: 403, statusMessage: "账号不可用，请联系管理员" });
  }
  const timestamp = Date.now();
  const ip = getClientIp(event);
  getSqliteDatabase().run("UPDATE users SET last_login_at = ?, last_login_ip = ?, updated_at = ? WHERE id = ?", timestamp, ip, timestamp, user.id);
  user.last_login_at = timestamp;
  user.last_login_ip = ip;
  rotateSession(getUserSession(event, { createAnonymous: true }), event, user);
  return { ok: true, status: "confirmed", user: publicUser(user) };
});
