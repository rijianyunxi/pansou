import { createError } from "h3";
import { getSqliteDatabase } from "../storage/sqlite";
import { getStoredChannels, hashPassword, updateStoredChannels, validateNickname, validatePassword, validateUsername } from "../../utils/userAuth";

export type AdminUserRecord = {
  id: number;
  username: string;
  nickname: string | null;
  status: "active" | "disabled";
  mustChangePassword: boolean;
  channelCount: number;
  lastLoginAt: number | null;
  createdAt: number;
  updatedAt: number;
};

type UserRow = {
  id: number;
  username: string;
  nickname: string | null;
  status: "active" | "disabled";
  must_change_password: number;
  custom_channels_json: string;
  last_login_at: number | null;
  created_at: number;
  updated_at: number;
};

function userFromRow(row: UserRow): AdminUserRecord {
  return {
    id: row.id,
    username: row.username,
    nickname: row.nickname,
    status: row.status,
    mustChangePassword: Boolean(row.must_change_password),
    channelCount: getStoredChannels(row as UserRow & { password_hash: string }).length,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getAdminUser(userId: number): UserRow {
  const user = getSqliteDatabase().getRow<UserRow>("SELECT id,username,nickname,status,must_change_password,custom_channels_json,last_login_at,created_at,updated_at FROM users WHERE id = ?", userId);
  if (!user) throw createError({ statusCode: 404, statusMessage: "user not found" });
  return user;
}

export function toAdminUser(row: UserRow): AdminUserRecord { return userFromRow(row); }

export function parseUserId(value: unknown): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw createError({ statusCode: 400, statusMessage: "invalid user id" });
  return id;
}

export function listAdminUsers(options: { page: number; pageSize: number; username?: string; status?: string }) {
  const db = getSqliteDatabase();
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.username) {
    where.push("username_normalized LIKE ?");
    params.push(`%${options.username.trim().toLowerCase()}%`);
  }
  if (options.status === "active" || options.status === "disabled") {
    where.push("status = ?");
    params.push(options.status);
  }
  const condition = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const totalRow = db.getRow<{ total: number }>(`SELECT COUNT(*) AS total FROM users${condition}`, ...params);
  const total = Number(totalRow?.total || 0);
  const rows = db.allRows<UserRow>(`SELECT id,username,nickname,status,must_change_password,custom_channels_json,last_login_at,created_at,updated_at FROM users${condition} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`, ...params, options.pageSize, (options.page - 1) * options.pageSize);
  const users = rows.map(toAdminUser);
  return { users, items: users, total, page: options.page, pageSize: options.pageSize, totalPages: Math.ceil(total / options.pageSize) };
}

export function createAdminUser(input: { username: unknown; password: unknown; nickname?: unknown; mustChangePassword?: unknown }): AdminUserRecord {
  const username = validateUsername(input.username);
  const password = validatePassword(input.password);
  const nickname = validateNickname(input.nickname);
  const timestamp = Date.now();
  const db = getSqliteDatabase();
  try {
    const result = db.run("INSERT INTO users(username,username_normalized,password_hash,nickname,status,must_change_password,custom_channels_json,custom_channels_updated_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", username, username.toLowerCase(), hashPassword(password), nickname, "active", input.mustChangePassword === true ? 1 : 0, "[]", timestamp, timestamp, timestamp);
    return toAdminUser(getAdminUser(Number(result.lastInsertRowid)));
  } catch (error: any) {
    if (String(error?.code || "").includes("SQLITE_CONSTRAINT")) throw createError({ statusCode: 409, statusMessage: "username already exists" });
    throw error;
  }
}

export function setAdminUserStatus(userId: number, status: "active" | "disabled"): AdminUserRecord {
  const user = getAdminUser(userId);
  const db = getSqliteDatabase();
  db.transaction(() => {
    db.run("UPDATE users SET status = ?, updated_at = ? WHERE id = ?", status, Date.now(), user.id);
    if (status === "disabled") db.run("DELETE FROM sessions WHERE user_id = ?", user.id);
  });
  return toAdminUser(getAdminUser(userId));
}

export function resetAdminUserPassword(userId: number, password: unknown): AdminUserRecord {
  const user = getAdminUser(userId);
  const nextPassword = validatePassword(password);
  const db = getSqliteDatabase();
  db.transaction(() => {
    db.run("UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?", hashPassword(nextPassword), Date.now(), user.id);
    db.run("DELETE FROM sessions WHERE user_id = ?", user.id);
  });
  return toAdminUser(getAdminUser(userId));
}

export function revokeAdminUserSessions(userId: number): { revoked: number } {
  const user = getAdminUser(userId);
  const result = getSqliteDatabase().run("DELETE FROM sessions WHERE user_id = ?", user.id);
  return { revoked: result.changes };
}

export function getAdminUserChannels(userId: number) {
  const user = getAdminUser(userId);
  const channels = getStoredChannels(user as UserRow & { password_hash: string });
  return { userId: user.id, username: user.username, channels, count: channels.length };
}

export function deleteAdminUserChannel(userId: number, channel: string) {
  const user = getAdminUser(userId);
  const normalized = channel.trim().replace(/^@/, "").toLowerCase();
  if (!normalized) throw createError({ statusCode: 400, statusMessage: "invalid channel" });
  const channels = getStoredChannels(user as UserRow & { password_hash: string });
  const next = channels.filter((item) => item !== normalized);
  if (next.length === channels.length) throw createError({ statusCode: 404, statusMessage: "channel not found" });
  updateStoredChannels(user.id, next);
  return { userId: user.id, channel: normalized, channels: next, count: next.length };
}
