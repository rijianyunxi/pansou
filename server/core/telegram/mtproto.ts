// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { Api, TelegramClient as TelegramClientType } from "telegram";
import type { StringSession as StringSessionType } from "telegram/sessions/StringSession";
const require = createRequire(import.meta.url);
const { Api: ApiRuntime, TelegramClient } = require("telegram") as { Api: any; TelegramClient: typeof TelegramClientType };
const { StringSession } = require("telegram/sessions/StringSession") as { StringSession: typeof StringSessionType };
const { computeCheck } = require("telegram/Password") as typeof import("telegram/Password");
const { returnBigInt } = require("telegram/Helpers") as typeof import("telegram/Helpers");
import { mtprotoConfig as config, hasMtprotoCredentials as hasCredentials } from "./mtprotoConfig";

/** 给 HTTP 层用的业务错误，带状态码 */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 内部哨兵错误：用户主动取消登录流程，不作为故障上报 */
const AUTH_CANCEL = "AUTH_USER_CANCEL";

export interface TgUser {
  id: string;
  firstName: string;
  lastName: string;
  username: string | null;
  phone: string | null;
}

export interface ChannelItem {
  /** 传给 /api/channel/* 接口的目标标识：公开频道为用户名，私有频道为数字 id */
  ref: string;
  id: string;
  title: string;
  username: string | null;
  verified: boolean;
  broadcast: boolean;
  megagroup: boolean;
  participantsCount: number | null;
  about: string | null;
  unreadCount?: number | null;
}

export interface MessageItem {
  id: number;
  date: number;
  text: string;
}

/** 供 HTTP 层轮询的登录状态快照 */
export interface LoginStateView {
  user: TgUser | null;
  qrRunning: boolean;
  qrToken: string | null;
  qrExpiresAt: number | null;
  phone: { isCodeViaApp: boolean; needPassword: boolean } | null;
  passwordNeeded: boolean;
  passwordHint: string | null;
  passwordError: string | null;
  error: string | null;
}

interface PhoneLogin {
  phoneNumber: string;
  phoneCodeHash: string;
  isCodeViaApp: boolean;
  needPassword: boolean;
}

const state = {
  user: null as TgUser | null,
  qr: null as { token: string; expiresAt: number } | null,
  qrRunning: false,
  qrCancelled: false,
  phone: null as PhoneLogin | null,
  passwordNeeded: false,
  passwordHint: null as string | null,
  passwordError: null as string | null,
  error: null as string | null,
};

let client: TelegramClientType | null = null;
let clientPromise: Promise<TelegramClientType> | null = null;

let passwordWaiter: { resolve: (password: string) => void } | null = null;

/** 本进程内缓存的频道实体（dialogs / 搜索结果），用于私有频道的后续查询 */
const entityCache = new Map<string, Api.TypeChat>();

function credentials() {
  return { apiId: config.apiId, apiHash: config.apiHash };
}

function readSessionFile(): string {
  try {
    return fs.readFileSync(config.sessionFile, "utf8").trim();
  } catch {
    return "";
  }
}

function saveSessionFile(c: TelegramClientType): void {
  // 客户端始终用 StringSession 构造
  const saved = (c.session as StringSessionType).save();
  fs.mkdirSync(path.dirname(config.sessionFile), { recursive: true });
  fs.writeFileSync(config.sessionFile, saved, "utf8");
}

function removeSessionFile(): void {
  try {
    fs.rmSync(config.sessionFile, { force: true });
  } catch {
    // 忽略
  }
}

async function createClient(): Promise<TelegramClientType> {
  if (!hasCredentials()) {
    throw new HttpError(
      500,
      "Telegram 登录服务尚未完成配置，请联系管理员处理。",
    );
  }
  const c = new TelegramClient(new StringSession(readSessionFile()), config.apiId, config.apiHash, {
    connectionRetries: 5,
  });
  await c.connect();
  return c;
}

export function getTelegramClient(): Promise<TelegramClientType> {
  if (client) return Promise.resolve(client);
  if (!clientPromise) {
    clientPromise = createClient()
      .then((c) => {
        client = c;
        return c;
      })
      .catch((err) => {
        clientPromise = null;
        throw err;
      });
  }
  return clientPromise;
}

function mapUser(user: Api.User): TgUser {
  return {
    id: user.id.toString(),
    firstName: user.firstName ?? "",
    lastName: user.lastName ?? "",
    username: user.username ?? null,
    phone: user.phone ?? null,
  };
}

async function onLoginSuccess(c: TelegramClientType): Promise<void> {
  state.user = mapUser(await c.getMe());
  state.qr = null;
  state.phone = null;
  state.passwordNeeded = false;
  state.passwordHint = null;
  state.passwordError = null;
  state.error = null;
  saveSessionFile(c);
}

export function getLoginState(): LoginStateView {
  return {
    user: state.user,
    qrRunning: state.qrRunning,
    qrToken: state.qr?.token ?? null,
    qrExpiresAt: state.qr?.expiresAt ?? null,
    phone: state.phone
      ? { isCodeViaApp: state.phone.isCodeViaApp, needPassword: state.phone.needPassword }
      : null,
    passwordNeeded: state.passwordNeeded,
    passwordHint: state.passwordHint,
    passwordError: state.passwordError,
    error: state.error,
  };
}

function rpcMessage(err: unknown): string | null {
  const msg = (err as { errorMessage?: unknown })?.errorMessage;
  return typeof msg === "string" ? msg : null;
}

function isCancelled(err: unknown): boolean {
  return err instanceof Error && (err.message === AUTH_CANCEL || rpcMessage(err) === AUTH_CANCEL);
}

const ERROR_MESSAGES: Record<string, string> = {
  PHONE_NUMBER_INVALID: "手机号格式不正确，需带国家区号，如 +8613800138000",
  PHONE_NUMBER_UNOCCUPIED: "该手机号未注册 Telegram 账号",
  PHONE_NUMBER_BANNED_BY_SERVER: "该手机号已被 Telegram 封禁",
  PHONE_CODE_INVALID: "验证码不正确",
  PHONE_CODE_EXPIRED: "验证码已过期，请重新发送",
  API_ID_INVALID: "Telegram 登录服务配置无效，请联系管理员检查服务端配置。",
  API_ID_PUBLISHED_FLOOD: "Telegram 登录服务当前受到平台限制，请稍后再试或联系管理员。",
  AUTH_ALREADY_AUTHORIZED: "当前会话已经登录，无需重复登录",
  AUTH_KEY_UNREGISTERED: "Telegram 登录状态已失效，请重新登录。",
  SESSION_PASSWORD_NEEDED: "该账号开启了两步验证，需要输入密码",
  PASSWORD_HASH_INVALID: "两步验证密码不正确",
  AUTH_CODE_INVALID: "验证码不正确",
};

function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  const code = rpcMessage(err);
  if (code && ERROR_MESSAGES[code]) return new HttpError(400, ERROR_MESSAGES[code]);
  if (code?.startsWith("FLOOD_WAIT_")) {
    const seconds = code.split("_").at(-1);
    return new HttpError(429, `请求过于频繁（FloodWait），请 ${seconds} 秒后再试`);
  }
  return new HttpError(500, err instanceof Error ? err.message : String(err));
}

function fail(err: unknown): never {
  throw toHttpError(err);
}

function waitForPassword(timeoutMs = 3 * 60_000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      passwordWaiter = null;
      reject(new Error(AUTH_CANCEL));
    }, timeoutMs);
    passwordWaiter = {
      resolve: (password) => {
        clearTimeout(timer);
        passwordWaiter = null;
        resolve(password);
      },
    };
  });
}

/** 用户提交的两步验证密码：若扫码流程正在等待则转交，返回 true */
export function submitPasswordToQrFlow(password: string): boolean {
  if (!passwordWaiter) return false;
  passwordWaiter.resolve(password);
  return true;
}

export function cancelQrLogin(): void {
  state.qrCancelled = true;
  state.passwordNeeded = false;
}

export function cancelPhoneLogin(): void {
  state.phone = null;
  state.passwordNeeded = false;
}

/** 启动扫码登录：后台持续导出 login token（每 30 秒刷新一次二维码） */
export async function startQrLogin(): Promise<void> {
  const c = await getTelegramClient();
  if (await c.isUserAuthorized()) throw new HttpError(400, "已经登录，无需再次登录");
  if (state.qrRunning) return;
  cancelPhoneLogin();

  state.qrCancelled = false;
  state.qr = null;
  state.error = null;
  state.user = null;
  state.passwordError = null;
  state.qrRunning = true;

  void (async () => {
    try {
      const user = await c.signInUserWithQrCode(credentials(), {
        qrCode: async ({ token, expires }) => {
          if (state.qrCancelled) throw new Error(AUTH_CANCEL);
          state.qr = { token: token.toString("base64url"), expiresAt: expires * 1000 };
        },
        password: async (hint) => {
          state.passwordNeeded = true;
          state.passwordHint = hint || null;
          state.passwordError = null;
          try {
            return await waitForPassword();
          } finally {
            state.passwordNeeded = false;
          }
        },
        onError: async (err) => {
          if (rpcMessage(err) === "PASSWORD_HASH_INVALID") {
            state.passwordError = "两步验证密码不正确，请重新输入";
            return false; // 不终止流程，等待重新提交密码
          }
          state.error = rpcMessage(err) ?? err.message;
          return true;
        },
      });
      if (user instanceof ApiRuntime.User) {
        await onLoginSuccess(c);
      } else {
        state.error = "登录流程异常结束";
      }
    } catch (err) {
      if (!isCancelled(err) && !state.qrCancelled) {
        state.error = toHttpError(err).message;
      }
    } finally {
      state.qrRunning = false;
      state.qr = null;
      state.passwordNeeded = false;
    }
  })();
}

/** 发送手机号验证码 */
export async function sendLoginCode(phoneNumber: string): Promise<{ isCodeViaApp: boolean }> {
  const c = await getTelegramClient();
  if (await c.isUserAuthorized()) throw new HttpError(400, "已经登录，无需再次登录");
  cancelQrLogin();
  state.phone = null;
  state.error = null;
  state.user = null;

  try {
    const { phoneCodeHash, isCodeViaApp } = await c.sendCode(credentials(), phoneNumber);
    state.phone = { phoneNumber, phoneCodeHash, isCodeViaApp, needPassword: false };
    return { isCodeViaApp };
  } catch (err) {
    fail(err);
  }
}

/** 用验证码登录；若账号开启两步验证则返回 needPassword */
export async function verifyLoginCode(
  code: string,
): Promise<{ ok: true } | { needPassword: true; hint: string | null }> {
  const c = await getTelegramClient();
  const phoneLogin = state.phone;
  if (!phoneLogin) throw new HttpError(400, "请先发送验证码");

  try {
    const result = await c.invoke(
      new ApiRuntime.auth.SignIn({
        phoneNumber: phoneLogin.phoneNumber,
        phoneCodeHash: phoneLogin.phoneCodeHash,
        phoneCode: code,
      }),
    );
    if (result instanceof ApiRuntime.auth.Authorization) {
      await onLoginSuccess(c);
      return { ok: true };
    }
    throw new HttpError(400, "该手机号尚未注册 Telegram 账号，请确认手机号后重试。");
  } catch (err) {
    if (rpcMessage(err) === "SESSION_PASSWORD_NEEDED") {
      const pwdInfo = await c.invoke(new ApiRuntime.account.GetPassword());
      phoneLogin.needPassword = true;
      state.passwordNeeded = false; // 手机号流程的密码走一次性 HTTP 调用，不挂起等待
      state.passwordHint = pwdInfo.hint || null;
      state.passwordError = null;
      return { needPassword: true, hint: state.passwordHint };
    }
    fail(err);
  }
}

/** 手机号登录流程的两步验证密码校验（SRP） */
export async function checkPhoneLoginPassword(password: string): Promise<{ ok: true }> {
  const c = await getTelegramClient();
  if (!state.phone?.needPassword) throw new HttpError(400, "当前没有等待两步验证的登录流程");
  try {
    const pwdInfo = await c.invoke(new ApiRuntime.account.GetPassword());
    const srp = await computeCheck(pwdInfo, password);
    await c.invoke(new ApiRuntime.auth.CheckPassword({ password: srp }));
    await onLoginSuccess(c);
    return { ok: true };
  } catch (err) {
    if (rpcMessage(err) === "PASSWORD_HASH_INVALID") {
      throw new HttpError(401, "两步验证密码不正确");
    }
    fail(err);
  }
}

export async function getCurrentUser(): Promise<{ authorized: boolean; user: TgUser | null; error?: string }> {
  if (!hasCredentials()) return { authorized: false, user: null };
  try {
    const c = await getTelegramClient();
    if (!(await c.isUserAuthorized())) return { authorized: false, user: null };
    if (!state.user) state.user = mapUser(await c.getMe());
    return { authorized: true, user: state.user };
  } catch (error) {
    // 网络不可达时不能等同于“会话已失效”，否则用户会被误导去重新登录。
    const code = rpcMessage(error);
    if (code === "AUTH_KEY_UNREGISTERED") {
      return { authorized: false, user: null, error: ERROR_MESSAGES.AUTH_KEY_UNREGISTERED };
    }
    return {
      authorized: false,
      user: null,
      error: "暂时无法连接 Telegram，请检查服务器网络或代理配置；当前不一定需要重新登录。",
    };
  }
}
async function requireAuthorizedClient(): Promise<TelegramClientType> {
  const c = await getTelegramClient();
  if (!(await c.isUserAuthorized())) throw new HttpError(401, "请先登录");
  return c;
}

function channelToItem(channel: Api.Channel, extra?: Partial<ChannelItem>): ChannelItem {
  const id = channel.id.toString();
  entityCache.set(id, channel);
  return {
    ref: channel.username ?? id,
    id,
    title: channel.title,
    username: channel.username ?? null,
    verified: Boolean(channel.verified),
    broadcast: Boolean(channel.broadcast),
    megagroup: Boolean(channel.megagroup),
    participantsCount: null,
    about: null,
    ...extra,
  };
}

/** 我加入的频道 / 群组：messages.getDialogs 过滤 */
export async function getMyChannels(): Promise<ChannelItem[]> {
  const c = await requireAuthorizedClient();
  const dialogs = await c.getDialogs({ limit: 100 });
  const items: ChannelItem[] = [];
  for (const dialog of dialogs) {
    const entity = dialog.entity;
    if (entity instanceof ApiRuntime.Channel) {
      items.push(
        channelToItem(entity, {
          unreadCount: dialog.unreadCount,
        }),
      );
    } else if (entity instanceof ApiRuntime.Chat) {
      // 普通小组（非超级群组）
      const id = entity.id.toString();
      entityCache.set(id, entity);
      items.push({
        ref: id,
        id,
        title: entity.title,
        username: null,
        verified: false,
        broadcast: false,
        megagroup: true,
        participantsCount: entity.participantsCount ?? null,
        about: null,
        unreadCount: dialog.unreadCount,
      });
    }
  }
  return items;
}

/**
 * 在指定频道 / 群组内搜索消息：messages.search。
 * Telegram 服务端对中文没有分词索引，q=「兰香如故」会按单字模糊匹配（消息里散落出现兰/香/如/故就算命中），
 * 因此这里在客户端再做一次子串精确过滤，并自动向更早翻页，直到凑够 limit 条精确命中或扫完服务端候选。
 */
export async function searchChannelMessages(
  channelRef: string,
  query: string,
  limit = 30,
  offsetId = 0,
): Promise<{ items: MessageItem[]; nextOffsetId: number | null; scanned: number }> {
  const c = await requireAuthorizedClient();
  const peer = await resolvePeer(c, channelRef);
  // 空格分隔的多个词按 AND 处理，与服务端语义一致；忽略大小写
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: MessageItem[] = [];
  let cursor = offsetId;
  let scanned = 0;
  let exhausted = false;

  for (let page = 0; page < 10 && hits.length < limit; page++) {
    const result = await c.invoke(
      new ApiRuntime.messages.Search({
        peer,
        q: query,
        filter: new ApiRuntime.InputMessagesFilterEmpty(),
        minDate: 0,
        maxDate: 0,
        offsetId: cursor,
        addOffset: 0,
        limit: 100,
        maxId: 0,
        minId: 0,
        hash: returnBigInt(0),
      }),
    );
    if (!("messages" in result) || result.messages.length === 0) {
      exhausted = true;
      break;
    }
    scanned += result.messages.length;
    for (const message of result.messages) {
      if (!(message instanceof ApiRuntime.Message)) continue;
      const rawText = message.message || (message.media ? "[媒体消息]" : "");
      if (terms.every((term) => rawText.toLowerCase().includes(term))) {
        hits.push({ id: message.id, date: (message.date ?? 0) * 1000, text: rawText });
        if (hits.length >= limit) break;
      }
    }
    const lastMessage = result.messages.at(-1);
    if (lastMessage && "id" in lastMessage) cursor = lastMessage.id;
  }
  // 因凑够 limit 中途停止时，游标回退到最后一条命中，避免跳过同页内未返回的消息
  if (hits.length >= limit && hits.length > 0) {
    cursor = hits[hits.length - 1]!.id;
  }
  return { items: hits, nextOffsetId: exhausted ? null : cursor || null, scanned };
}

/** 拉取某个频道 / 群组的最近消息 */
export async function getChannelMessages(channelRef: string, limit = 15): Promise<MessageItem[]> {
  const c = await requireAuthorizedClient();
  const peer = await resolvePeer(c, channelRef);
  const messages = await c.getMessages(peer, { limit });
  return messages.map((message) => ({
    id: message.id,
    date: (message.date ?? 0) * 1000,
    text: message.message || (message.media ? "[媒体消息]" : ""),
  }));
}

export async function logout(): Promise<void> {
  const oldClient = client;
  client = null;
  clientPromise = null;
  passwordWaiter = null;
  state.user = null;
  state.qr = null;
  state.qrRunning = false;
  state.qrCancelled = true;
  state.phone = null;
  state.passwordNeeded = false;
  state.passwordHint = null;
  state.passwordError = null;
  state.error = null;
  removeSessionFile();

  if (!oldClient) return;
  try {
    if (await oldClient.isUserAuthorized()) {
      await oldClient.invoke(new ApiRuntime.auth.LogOut());
    }
  } catch {
    // 服务端登出失败也照常清空本地会话
  }
  try {
    await oldClient.disconnect();
  } catch {
    // 忽略
  }
}
