import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import type { H3Event } from "h3";
import { createError, getCookie, getHeader, getRequestURL, setHeader } from "h3";
import { getSqliteDatabase } from "../core/storage/sqlite";
import { getUserPolicy } from "../core/services/policyService";
import { MAX_USER_TG_CHANNELS } from "../../utils/telegramChannels";

export const USER_SESSION_COOKIE = "panhub_session";
const COOKIE_PATH = "/";
const USERNAME_PATTERN = /^[A-Za-z0-9_]{4,32}$/;
const MAX_NICKNAME_LENGTH = 32;

type SessionRow = {
  id: number; token_hash: string; user_id: number | null; kind: "anonymous" | "user";
  created_at: number; expires_at: number; last_seen_at: number; custom_channels_json: string;
};
type UserRow = {
  id: number; username: string; username_normalized: string; password_hash: string; nickname: string | null;
  status: "active" | "disabled"; role: "admin" | "user"; must_change_password: number; custom_channels_json: string;
  custom_channels_updated_at: number; last_login_ip: string | null; last_login_at: number | null; created_at: number; updated_at: number; deleted_at: number | null;
};

export interface UserSessionContext {
  session: SessionRow;
  user: UserRow | null;
  token: string;
}

function now(): number { return Date.now(); }
function tokenHash(token: string): string { return createHash("sha256").update(token, "utf8").digest("hex"); }
function normalizeUsername(username: string): string { return username.trim().toLowerCase(); }
function cookieSecure(event: H3Event): string { return getRequestURL(event).protocol === "https:" ? "; Secure" : ""; }
function setSessionCookie(event: H3Event, token: string, maxAgeSeconds: number): void {
  setHeader(event, "Set-Cookie", `${USER_SESSION_COOKIE}=${token}; Path=${COOKIE_PATH}; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${cookieSecure(event)}`);
}
export function clearUserSessionCookie(event: H3Event): void {
  setHeader(event, "Set-Cookie", `${USER_SESSION_COOKIE}=; Path=${COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax${cookieSecure(event)}`);
}

export function validateUsername(username: unknown): string {
  if (typeof username !== "string" || !USERNAME_PATTERN.test(username.trim())) throw createError({ statusCode: 400, statusMessage: "用户名需为 4-32 位字母、数字或下划线" });
  return username.trim();
}
export function validatePassword(password: unknown): string {
  if (typeof password !== "string" || password.length < 6 || password.length > 128) throw createError({ statusCode: 400, statusMessage: "密码长度需为 6-128 个字符" });
  return password;
}
export function validateNickname(nickname: unknown): string | null {
  if (nickname === undefined || nickname === null || nickname === "") return null;
  if (typeof nickname !== "string" || [...nickname].length > MAX_NICKNAME_LENGTH) throw createError({ statusCode: 400, statusMessage: "昵称最多 32 个字符" });
  return nickname;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}
export function verifyPassword(password: string, encoded: string): boolean {
  try {
    const [kind, n, r, p, saltText, hashText] = encoded.split("$");
    if (kind !== "scrypt" || !n || !r || !p || !saltText || !hashText) return false;
    const expected = Buffer.from(hashText, "base64url");
    const actual = scryptSync(password, Buffer.from(saltText, "base64url"), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch { return false; }
}

function createToken(): string { return randomBytes(32).toString("base64url"); }

export function createRandomUserId(): number {
  const db = getSqliteDatabase();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = randomInt(100_000_000, 1_000_000_000);
    if (!db.getRow("SELECT 1 FROM users WHERE id = ?", id)) return id;
  }
  throw new Error("无法生成唯一用户 ID");
}
function sessionExpiry(kind: "anonymous" | "user"): number {
  const policy = getUserPolicy();
  return now() + policy.sessionDays * 86400000;
}

function findSession(token: string): SessionRow | undefined {
  return getSqliteDatabase().getRow<SessionRow>("SELECT * FROM sessions WHERE token_hash = ?", tokenHash(token));
}
function userForSession(session: SessionRow): UserRow | null {
  return session.user_id === null ? null : getSqliteDatabase().getRow<UserRow>("SELECT * FROM users WHERE id = ?", session.user_id) ?? null;
}

export function createAnonymousSession(event: H3Event): UserSessionContext {
  const db = getSqliteDatabase(); const token = createToken(); const timestamp = now();
  const result = db.run("INSERT INTO sessions(token_hash,user_id,kind,created_at,expires_at,last_seen_at,custom_channels_json) VALUES(?,?,?,?,?,?,?)", tokenHash(token), null, "anonymous", timestamp, sessionExpiry("anonymous"), timestamp, "[]");
  const session = db.getRow<SessionRow>("SELECT * FROM sessions WHERE id = ?", result.lastInsertRowid as number)!;
  setSessionCookie(event, token, getUserPolicy().sessionDays * 86400);
  return { session, user: null, token };
}

export function getUserSession(event: H3Event, options: { createAnonymous?: boolean; allowMustChange?: boolean } = {}): UserSessionContext {
  const token = getCookie(event, USER_SESSION_COOKIE);
  if (!token) {
    if (options.createAnonymous) return createAnonymousSession(event);
    throw createError({ statusCode: 401, statusMessage: "登录会话不存在" });
  }
  const session = findSession(token);
  if (!session || session.expires_at <= now()) throw createError({ statusCode: 401, statusMessage: "登录会话已失效，请重新登录" });
  const user = userForSession(session);
  if (session.kind === "user" && (!user || user.status !== "active" || user.deleted_at)) throw createError({ statusCode: 401, statusMessage: "登录会话已失效，请重新登录" });
  getSqliteDatabase().run("UPDATE sessions SET last_seen_at = ? WHERE id = ?", now(), session.id);
  if (user && user.must_change_password && !options.allowMustChange) throw createError({ statusCode: 403, statusMessage: "请先修改密码" });
  return { session, user, token };
}

export function requireUserSession(event: H3Event, options: { allowMustChange?: boolean } = {}): UserSessionContext & { user: UserRow } {
  const context = getUserSession(event, options);
  if (!context.user) throw createError({ statusCode: 401, statusMessage: "请先登录" });
  return context as UserSessionContext & { user: UserRow };
}

export function rotateSession(context: UserSessionContext, event: H3Event, user: UserRow | null): UserSessionContext {
  const token = createToken(); const kind = user ? "user" : "anonymous";
  const expiresAt = sessionExpiry(kind); const timestamp = now(); const db = getSqliteDatabase();

  // If an anonymous session was allowed to manage channels, carry those
  // channels into the account on login/register. The account remains the
  // canonical store after the session becomes authenticated.
  if (user && !context.user) {
    const anonymousChannels = getStoredChannelsFromJson(context.session.custom_channels_json);
    if (anonymousChannels.length) {
      const accountChannels = getStoredChannels(user);
      const merged = [...new Set([...accountChannels, ...anonymousChannels])].slice(0, Math.min(MAX_USER_TG_CHANNELS, getUserPolicy().customChannelLimit));
      user.custom_channels_json = JSON.stringify(merged);
      user.custom_channels_updated_at = timestamp;
      user.updated_at = timestamp;
      db.run("UPDATE users SET custom_channels_json = ?, custom_channels_updated_at = ?, updated_at = ? WHERE id = ?", user.custom_channels_json, timestamp, timestamp, user.id);
    }
  }

  // A user session never needs its own channel copy. Clearing this field when
  // logging out guarantees that the next anonymous session starts empty.
  db.run("UPDATE sessions SET token_hash = ?, user_id = ?, kind = ?, expires_at = ?, last_seen_at = ?, custom_channels_json = ? WHERE id = ?", tokenHash(token), user?.id ?? null, kind, expiresAt, timestamp, "[]", context.session.id);
  setSessionCookie(event, token, (expiresAt - timestamp) / 1000);
  const session = db.getRow<SessionRow>("SELECT * FROM sessions WHERE id = ?", context.session.id)!;
  return { session, user, token };
}

export function revokeUserSessions(userId: number): void { getSqliteDatabase().run("DELETE FROM sessions WHERE user_id = ?", userId); }
export function revokeSession(context: UserSessionContext, event: H3Event): void {
  if (context.user) {
    const replacement = rotateSession(context, event, null);
    void replacement;
  } else clearUserSessionCookie(event);
}

export function getStoredChannelsFromJson(valueJson: string | null | undefined): string[] {
  try {
    const value = JSON.parse(valueJson || "[]");
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}
export function getStoredChannels(user: { custom_channels_json: string }): string[] {
  return getStoredChannelsFromJson(user.custom_channels_json);
}
export function getStoredSessionChannels(session: { custom_channels_json?: string | null }): string[] {
  return getStoredChannelsFromJson(session.custom_channels_json);
}
export function updateStoredChannels(userId: number, channels: string[]): UserRow {
  const timestamp = now(); const db = getSqliteDatabase();
  db.run("UPDATE users SET custom_channels_json = ?, custom_channels_updated_at = ?, updated_at = ? WHERE id = ?", JSON.stringify(channels), timestamp, timestamp, userId);
  return db.getRow<UserRow>("SELECT * FROM users WHERE id = ?", userId)!;
}
export function updateStoredSessionChannels(sessionId: number, channels: string[]): SessionRow {
  const db = getSqliteDatabase();
  db.run("UPDATE sessions SET custom_channels_json = ?, last_seen_at = ? WHERE id = ?", JSON.stringify(channels), now(), sessionId);
  return db.getRow<SessionRow>("SELECT * FROM sessions WHERE id = ?", sessionId)!;
}
export function publicUser(user: UserRow) {
  return { id: user.id, username: user.username, nickname: user.nickname, role: user.role, status: user.status, mustChangePassword: !!user.must_change_password, channels: getStoredChannels(user), lastLoginIp: user.last_login_ip, lastLoginAt: user.last_login_at, createdAt: user.created_at };
}

export function requireSameOriginUserRequest(event: H3Event): void {
  const origin = getHeader(event, "origin");
  if (!origin) return;
  try {
    if (new URL(origin).host !== getRequestURL(event).host) throw createError({ statusCode: 403, statusMessage: "跨站请求已拒绝" });
  } catch (error) { if ((error as any)?.statusCode) throw error; throw createError({ statusCode: 403, statusMessage: "跨站请求已拒绝" }); }
}

export function sessionCookieName(): string { return USER_SESSION_COOKIE; }
