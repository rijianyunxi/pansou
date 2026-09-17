import { randomBytes } from "node:crypto";
import { createError } from "h3";
import { getSqliteDatabase } from "../storage/sqlite";
import { exchangeWechatCode, resolveWechatUser, validateWechatCode, type WechatMiniConfig } from "./wechatMiniService";
import type { UserRow } from "../../utils/userAuth";

/**
 * Website sign-in by scanning a mini-program code.
 *
 * The browser never talks to WeChat directly. It asks for a ticket, renders the
 * mini-program code that carries that ticket, and polls until the mini program
 * confirms it. Confirmation is the only place an account is resolved, and it
 * goes through `resolveWechatUser`, so the account rules are exactly the ones
 * the in-mini-program sign-in already enforces.
 */

/** A code stays valid for three minutes; WeChat's own login code lives five. */
export const LOGIN_TICKET_TTL_MS = 3 * 60 * 1000;

/**
 * 12 random bytes → 24 hex characters. A mini-program code scene is limited to
 * 32 visible characters, so the ticket doubles as the scene and needs no
 * mapping table of its own.
 */
const TICKET_BYTES = 12;
const TICKET_PATTERN = /^[0-9a-f]{24}$/;

const WECHAT_API_BASE = "https://api.weixin.qq.com";
/** Refresh a cached access token early instead of racing its expiry. */
const ACCESS_TOKEN_SAFETY_MS = 60_000;
const ACCESS_TOKEN_FALLBACK_MS = 7_200_000;
const WECHAT_REQUEST_TIMEOUT_MS = 8_000;
const MAX_QRCODE_BYTES = 512 * 1024;
/** WeChat returns these two codes when the access token is stale or wrong. */
const ACCESS_TOKEN_ERROR_CODES = new Set([40001, 40014, 42001]);

export type LoginTicketStatus = "pending" | "confirmed" | "consumed";
export type QrLoginStatus = "pending" | "confirmed" | "expired";

export interface LoginTicketRow {
  ticket: string;
  status: LoginTicketStatus;
  user_id: number | null;
  ip: string | null;
  created_at: number;
  expires_at: number;
  confirmed_at: number | null;
  consumed_at: number | null;
}

export interface WechatQrOptions {
  /** Mini-program page the code opens. */
  qrPage: string;
  /** `trial` lets an unreleased build be scanned while integrating. */
  envVersion: "release" | "trial" | "develop";
}

export interface WechatQrLogin {
  ticket: string;
  expiresAt: number;
  /** `data:` URL of the mini-program code, ready to put in an `<img src>`. */
  qrImage: string;
}

const accessTokens = new Map<string, { token: string; expiresAt: number }>();

function expireCode(statusCode: number, message: string): never {
  throw createError({ statusCode, statusMessage: message });
}

/**
 * WeChat's own APIs are called with plain `fetch`, the same way
 * `wechatMiniService` calls code2Session: the host is a fixed first-party
 * endpoint, not a configured source URL, so the SSRF guards that
 * `executeSafeHttp` provides do not apply here. Never log these URLs — they
 * carry the app secret or an access token.
 */
async function fetchWechatJson(url: URL): Promise<any> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(WECHAT_REQUEST_TIMEOUT_MS), redirect: "error" });
  } catch {
    expireCode(502, "WeChat service unavailable");
  }
  if (!response.ok) expireCode(502, "WeChat service unavailable");
  try {
    return await response.json();
  } catch {
    expireCode(502, "Invalid WeChat response");
  }
}

function requireCredentials(config: WechatMiniConfig): void {
  if (!config.appId || !config.secret) expireCode(503, "WeChat login is not configured");
}

async function requestAccessToken(config: WechatMiniConfig): Promise<{ token: string; expiresAt: number }> {
  const url = new URL(`${WECHAT_API_BASE}/cgi-bin/token`);
  url.search = new URLSearchParams({ grant_type: "client_credential", appid: config.appId, secret: config.secret }).toString();
  const data = await fetchWechatJson(url);
  if (typeof data?.access_token !== "string" || !data.access_token) expireCode(502, "WeChat access token unavailable");
  const lifetime = Number(data.expires_in);
  const ttl = Number.isFinite(lifetime) && lifetime > 0 ? lifetime * 1000 : ACCESS_TOKEN_FALLBACK_MS;
  return { token: data.access_token, expiresAt: Date.now() + Math.max(60_000, ttl - ACCESS_TOKEN_SAFETY_MS) };
}

async function getAccessToken(config: WechatMiniConfig, forceRefresh = false): Promise<string> {
  const cached = accessTokens.get(config.appId);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.token;
  const next = await requestAccessToken(config);
  accessTokens.set(config.appId, next);
  return next.token;
}

/** Test seam: drops cached tokens so a stubbed fetch starts from a clean state. */
export function resetWechatAccessTokenCache(): void {
  accessTokens.clear();
}

async function requestMiniProgramCode(config: WechatMiniConfig, options: WechatQrOptions, ticket: string, token: string): Promise<Response> {
  return fetch(`${WECHAT_API_BASE}/wxa/getwxacodeunlimit?access_token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scene: ticket,
      page: options.qrPage,
      // An unpublished page must not make code generation fail.
      check_path: false,
      env_version: options.envVersion,
      width: 280,
    }),
    signal: AbortSignal.timeout(WECHAT_REQUEST_TIMEOUT_MS),
    redirect: "error",
  });
}

async function generateMiniProgramCode(config: WechatMiniConfig, options: WechatQrOptions, ticket: string): Promise<Buffer> {
  let token = await getAccessToken(config);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Response;
    try {
      response = await requestMiniProgramCode(config, options, ticket, token);
    } catch {
      expireCode(502, "WeChat service unavailable");
    }
    if (!response.ok) expireCode(502, "WeChat service unavailable");
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("application/json")) {
      // Errors arrive as JSON with a 200 status; only a stale token is worth retrying.
      const data = await response.json().catch(() => undefined);
      if (attempt === 0 && ACCESS_TOKEN_ERROR_CODES.has(Number(data?.errcode))) {
        token = await getAccessToken(config, true);
        continue;
      }
      expireCode(502, "WeChat mini program code unavailable");
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_QRCODE_BYTES) expireCode(502, "WeChat mini program code too large");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_QRCODE_BYTES) expireCode(502, "WeChat mini program code unavailable");
    return buffer;
  }
  expireCode(502, "WeChat mini program code unavailable");
}

export function normalizeLoginTicket(value: unknown): string {
  const ticket = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!TICKET_PATTERN.test(ticket)) throw createError({ statusCode: 400, statusMessage: "Invalid login ticket" });
  return ticket;
}

/** Expired tickets are unreachable by definition, so they are dropped on write. */
export function pruneLoginTickets(now = Date.now()): void {
  getSqliteDatabase().run("DELETE FROM login_tickets WHERE expires_at <= ?", now);
}

export function getLoginTicket(ticket: string): LoginTicketRow | undefined {
  return getSqliteDatabase().getRow<LoginTicketRow>("SELECT * FROM login_tickets WHERE ticket = ?", ticket);
}

/**
 * Issue a ticket and the mini-program code that carries it.
 *
 * A code that cannot be generated leaves no trace: the ticket is removed before
 * the error surfaces, so the table only ever holds codes the browser can use.
 */
export async function startWechatQrLogin(
  config: WechatMiniConfig,
  options: WechatQrOptions,
  ip: string,
  now = Date.now(),
): Promise<WechatQrLogin> {
  requireCredentials(config);
  pruneLoginTickets(now);
  const ticket = randomBytes(TICKET_BYTES).toString("hex");
  const expiresAt = now + LOGIN_TICKET_TTL_MS;
  getSqliteDatabase().run(
    "INSERT INTO login_tickets(ticket,status,user_id,ip,created_at,expires_at) VALUES(?,?,?,?,?,?)",
    ticket, "pending", null, ip, now, expiresAt,
  );
  try {
    const image = await generateMiniProgramCode(config, options, ticket);
    return { ticket, expiresAt, qrImage: `data:image/png;base64,${image.toString("base64")}` };
  } catch (error) {
    getSqliteDatabase().run("DELETE FROM login_tickets WHERE ticket = ?", ticket);
    throw error;
  }
}

/** Poll target. Unknown or expired tickets are indistinguishable on purpose. */
export function getWechatQrLoginStatus(ticket: string, now = Date.now()): QrLoginStatus {
  const row = getLoginTicket(ticket);
  if (!row || row.expires_at <= now) return "expired";
  if (row.status === "pending") return "pending";
  // A confirmed ticket is already being handed to a browser; a second poll that
  // arrives before the cookie is set should not read as a failure.
  return "confirmed";
}

export interface WechatQrConfirmation {
  user: UserRow;
}

/**
 * Confirm a scanned ticket from inside the mini program.
 *
 * The mini program sends the `scene` it was opened with plus a fresh
 * `wx.login` code. The code is exchanged for an openid and the account is
 * resolved exactly as the in-mini-program sign-in does it, which means a
 * first-time scanner gets an account here and a disabled or deleted account is
 * refused.
 */
export async function confirmWechatQrLogin(
  config: WechatMiniConfig,
  ticket: string,
  code: unknown,
  ip: string,
  now = Date.now(),
): Promise<WechatQrConfirmation> {
  requireCredentials(config);
  const row = getLoginTicket(ticket);
  if (!row || row.expires_at <= now) expireCode(410, "二维码已失效，请回到网页刷新后重试");
  if (row.status !== "pending") expireCode(409, "该二维码已被使用，请回到网页刷新后重试");
  const identity = await exchangeWechatCode(config, validateWechatCode(code));
  const user = resolveWechatUser(config, identity, ip, { autoProvision: true });
  const result = getSqliteDatabase().run(
    "UPDATE login_tickets SET status='confirmed',user_id=?,confirmed_at=? WHERE ticket=? AND status='pending' AND expires_at > ?",
    user.id, now, ticket, now,
  );
  if (result.changes !== 1) expireCode(409, "该二维码已被使用，请回到网页刷新后重试");
  return { user };
}

/**
 * Hand a confirmed ticket to the browser exactly once.
 *
 * Returns `undefined` for anything that is not a fresh confirmation, which the
 * caller reports as `pending`/`expired` rather than an error: a poll is a
 * question, not a command. Expiry is re-checked here because a ticket can be
 * confirmed moments before it lapses.
 */
export function consumeWechatQrLogin(ticket: string, now = Date.now()): number | undefined {
  const result = getSqliteDatabase().run(
    "UPDATE login_tickets SET status='consumed',consumed_at=? WHERE ticket=? AND status='confirmed' AND expires_at > ?",
    now, ticket, now,
  );
  if (result.changes !== 1) return undefined;
  const row = getLoginTicket(ticket);
  return row?.user_id ?? undefined;
}
