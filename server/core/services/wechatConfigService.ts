import { createError } from "h3";
import { getSqliteDatabase } from "../storage/sqlite";

/**
 * WeChat mini-program credentials and website sign-in code settings.
 *
 * These live in SQLite, not in runtime config, so the console can change them
 * without a redeploy or a process restart. The AppSecret is **write-only**:
 * `wechatMiniSettingsView` is the only shape that leaves the process, and it
 * reports whether a secret is stored without ever echoing any part of it.
 */

export type WechatEnvVersion = "release" | "trial" | "develop";

export interface WechatMiniSettings {
  appId: string;
  secret: string;
  qrPage: string;
  envVersion: WechatEnvVersion;
}

export const DEFAULT_WECHAT_MINI_SETTINGS: WechatMiniSettings = {
  appId: "",
  secret: "",
  qrPage: "pages/login/index",
  envVersion: "release",
};

// Real mini-program AppIDs are `wx` + 16 hex, but the pattern stays loose: a
// format we guess wrong must not block an operator from saving a valid value.
const APP_ID_PATTERN = /^[A-Za-z0-9]{6,64}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const QR_PAGE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_/-]{0,127}$/;
const ENV_VERSIONS = ["release", "trial", "develop"] as const;

function isEnvVersion(value: unknown): value is WechatEnvVersion {
  return typeof value === "string" && (ENV_VERSIONS as readonly string[]).includes(value);
}

/** A code page is written without a leading slash, the way WeChat expects it. */
export function normalizeQrPage(value: unknown, fallback = DEFAULT_WECHAT_MINI_SETTINGS.qrPage): string {
  if (typeof value !== "string") return fallback;
  const page = value.trim().replace(/^\/+/, "");
  return QR_PAGE_PATTERN.test(page) ? page : fallback;
}

export function normalizeEnvVersion(value: unknown, fallback = DEFAULT_WECHAT_MINI_SETTINGS.envVersion): WechatEnvVersion {
  return isEnvVersion(value) ? value : fallback;
}

export function normalizeAppId(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const appId = value.trim();
  return APP_ID_PATTERN.test(appId) ? appId : fallback;
}

export function normalizeSecret(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const secret = value.trim();
  return SECRET_PATTERN.test(secret) ? secret : fallback;
}

function badRequest(statusMessage: string): never {
  throw createError({ statusCode: 400, statusMessage });
}

/**
 * The write path is strict where the read path is tolerant: an operator who
 * pastes the wrong thing gets told, instead of silently keeping the old value.
 *
 * An explicit empty string clears the field. `configured` requires both an
 * AppID and a secret, so clearing either one is a clean way to switch WeChat
 * sign-in off without deleting the row.
 */
export function validateAppId(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  const appId = normalizeAppId(value, "");
  if (!appId) badRequest("AppID 只能包含 6–64 位字母或数字");
  return appId;
}

export function validateSecret(value: unknown): string {
  const secret = normalizeSecret(value, "");
  if (!secret) badRequest("AppSecret 只能包含 8–128 位字母、数字、下划线或连字符");
  return secret;
}

export function validateQrPage(value: unknown): string {
  if (value === undefined || value === null || value === "") return DEFAULT_WECHAT_MINI_SETTINGS.qrPage;
  const page = normalizeQrPage(value, "");
  if (!page) badRequest("小程序页面路径只能包含字母、数字、下划线、连字符和斜杠");
  return page;
}

export function validateEnvVersion(value: unknown): WechatEnvVersion {
  if (!isEnvVersion(value)) badRequest("envVersion 只能是 release、trial 或 develop");
  return value;
}

/**
 * Tolerant read. This runs on the sign-in hot path, so a value an older build
 * wrote must degrade to the default rather than break the request.
 *
 * A missing table is the same class of problem: `SCHEMA` creates it on every
 * start, but a long-running process can outlive the code that added it (and in
 * this project the dev server keeps the production database open). Answering
 * "not configured" beats answering 500.
 */
export function getWechatMiniSettings(): WechatMiniSettings {
  let row: { app_id: string; secret: string; qr_page: string; env_version: string } | undefined;
  try {
    row = getSqliteDatabase().getRow<{ app_id: string; secret: string; qr_page: string; env_version: string }>(
      "SELECT app_id,secret,qr_page,env_version FROM wechat_mini_settings WHERE id=1",
    );
  } catch {
    return { ...DEFAULT_WECHAT_MINI_SETTINGS };
  }
  if (!row) return { ...DEFAULT_WECHAT_MINI_SETTINGS };
  return {
    appId: normalizeAppId(row.app_id, ""),
    secret: normalizeSecret(row.secret, ""),
    qrPage: normalizeQrPage(row.qr_page),
    envVersion: normalizeEnvVersion(row.env_version),
  };
}

export interface WechatMiniSettingsPatch {
  appId?: unknown;
  secret?: unknown;
  qrPage?: unknown;
  envVersion?: unknown;
}

/**
 * The secret is write-only, so the console can never send the current value
 * back. An omitted or blank field therefore means "keep what is stored";
 * an explicit `null` means "clear it" — the only way to remove a secret that
 * was pasted wrong, since a blank field cannot express that.
 */
function keepsStoredSecret(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.trim() === "");
}

export function saveWechatMiniSettings(patch: WechatMiniSettingsPatch): WechatMiniSettings {
  const current = getWechatMiniSettings();
  const next: WechatMiniSettings = {
    appId: Object.prototype.hasOwnProperty.call(patch, "appId") ? validateAppId(patch.appId) : current.appId,
    secret: patch.secret === null ? "" : keepsStoredSecret(patch.secret) ? current.secret : validateSecret(patch.secret),
    qrPage: Object.prototype.hasOwnProperty.call(patch, "qrPage") ? validateQrPage(patch.qrPage) : current.qrPage,
    envVersion: Object.prototype.hasOwnProperty.call(patch, "envVersion") ? validateEnvVersion(patch.envVersion) : current.envVersion,
  };
  try {
    getSqliteDatabase().run(
      "INSERT INTO wechat_mini_settings(id,app_id,secret,qr_page,env_version,updated_at) VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET app_id=excluded.app_id,secret=excluded.secret,qr_page=excluded.qr_page,env_version=excluded.env_version,updated_at=excluded.updated_at",
      next.appId, next.secret, next.qrPage, next.envVersion, Date.now(),
    );
  } catch (error) {
    // The table is created by `SCHEMA` on every start, so this only happens when
    // the process is older than the code. Say so, instead of surfacing a raw
    // `SqliteError: no such table` that reads like a bug in the form.
    if (error instanceof Error && /no such table/i.test(error.message)) {
      throw createError({ statusCode: 503, statusMessage: "数据库结构尚未更新，请重启服务后重试" });
    }
    throw error;
  }
  return next;
}

export interface WechatMiniSettingsView {
  appId: string;
  qrPage: string;
  envVersion: WechatEnvVersion;
  secretConfigured: boolean;
  secretLength: number;
  configured: boolean;
}

/**
 * The only shape of these settings allowed to leave the process.
 *
 * The secret is reported as a flag plus its length — not a value and not a
 * prefix, since a masked prefix still narrows a guess and the console has no
 * use for it. Nothing here is routed through `core/utils/redaction.ts` because
 * nothing here carries a credential to redact in the first place.
 */
export function wechatMiniSettingsView(settings: WechatMiniSettings): WechatMiniSettingsView {
  return {
    appId: settings.appId,
    qrPage: settings.qrPage,
    envVersion: settings.envVersion,
    secretConfigured: settings.secret.length > 0,
    secretLength: settings.secret.length,
    configured: settings.appId.length > 0 && settings.secret.length > 0,
  };
}
