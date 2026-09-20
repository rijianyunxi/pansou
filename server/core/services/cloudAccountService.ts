import { createError } from "h3";
import { getSqliteDatabase } from "../storage/sqlite";

export interface QuarkAccountSettings {
  cookie: string;
}

export interface QuarkAccountSettingsView {
  configured: boolean;
  cookieLength: number;
}

function readQuarkSettings(): QuarkAccountSettings {
  try {
    const row = getSqliteDatabase().getRow<{ credential: string }>("SELECT credential FROM cloud_account_settings WHERE provider='quark'");
    return { cookie: typeof row?.credential === "string" ? row.credential : "" };
  } catch {
    return { cookie: "" };
  }
}

export function getQuarkCookie(): string {
  return readQuarkSettings().cookie;
}

export function quarkAccountSettingsView(): QuarkAccountSettingsView {
  const cookie = readQuarkSettings().cookie;
  return { configured: cookie.length > 0, cookieLength: cookie.length };
}

function validateCookie(value: unknown): string {
  if (typeof value !== "string") throw createError({ statusCode: 400, statusMessage: "夸克 Cookie 必须是字符串" });
  const cookie = value.trim();
  if (!cookie || cookie.length > 50_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(cookie)) throw createError({ statusCode: 400, statusMessage: "夸克 Cookie 格式或长度不合法" });
  return cookie;
}

export function saveQuarkCookie(value: unknown): QuarkAccountSettingsView {
  const cookie = value === null ? "" : validateCookie(value);
  try {
    getSqliteDatabase().run(
      "INSERT INTO cloud_account_settings(provider,credential,updated_at) VALUES('quark',?,?) ON CONFLICT(provider) DO UPDATE SET credential=excluded.credential,updated_at=excluded.updated_at",
      cookie,
      Date.now(),
    );
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) throw createError({ statusCode: 503, statusMessage: "数据库结构尚未更新，请重启服务后重试" });
    throw error;
  }
  return quarkAccountSettingsView();
}
