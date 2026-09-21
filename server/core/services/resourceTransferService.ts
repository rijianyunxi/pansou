import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { getSqliteDatabase } from "../storage/sqlite";
import type { Link } from "../types/models";
import { getManagedResource, replaceManagedResourceLink } from "./managedResourceService";
import { getBaiduCookie, getQuarkCookie } from "./cloudAccountService";

export type TransferProvider = "quark" | "baidu";
export type ResourceTransferStatus = "queued" | "running" | "completed" | "failed";

type TransferJobRow = {
  id: string;
  resource_id: string;
  link_index: number;
  provider: TransferProvider;
  source_url: string;
  source_password: string | null;
  target_folder: string;
  status: ResourceTransferStatus;
  replacement_url: string | null;
  replacement_password: string | null;
  error_message: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  updated_at: number;
};

export interface ResourceTransferJob {
  id: string;
  resourceId: string;
  linkIndex: number;
  provider: TransferProvider;
  targetFolder: string;
  status: ResourceTransferStatus;
  replacementUrl: string | null;
  replacementPassword: string | null;
  errorMessage: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

function rowToJob(row: TransferJobRow): ResourceTransferJob {
  return {
    id: row.id,
    resourceId: row.resource_id,
    linkIndex: row.link_index,
    provider: row.provider,
    targetFolder: row.target_folder,
    status: row.status,
    replacementUrl: row.replacement_url,
    replacementPassword: row.replacement_password,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function cleanFolder(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") throw new Error("目标文件夹必须是字符串");
  const folder = value.trim();
  if (!folder || folder.length > 300 || /[\u0000-\u001f\\]/u.test(folder) || folder.includes("..")) throw new Error("目标文件夹格式不合法");
  return folder.startsWith("/") ? folder : `/${folder}`;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/[^\s]+/giu, "[分享链接]").slice(0, 500) || "转存失败";
}

function defaultFolder(resourceId: string): string {
  const safeId = resourceId.replace(/[^a-zA-Z0-9_-]/gu, "-").slice(0, 80);
  return `/PanHub/${safeId}`;
}

export function createResourceTransferJob(input: { resourceId: string; linkIndex: number; provider: TransferProvider; targetFolder?: unknown }): ResourceTransferJob {
  const resource = getManagedResource(input.resourceId);
  if (!resource) throw new Error("资源不存在");
  const link = resource.links[input.linkIndex];
  if (!link) throw new Error("原链接位置不存在");
  if (link.type !== input.provider) throw new Error("当前版本只支持同网盘转存，请选择对应类型的原链接");
  const targetFolder = cleanFolder(input.targetFolder, defaultFolder(resource.id));
  const now = Date.now();
  const id = randomUUID();
  const db = getSqliteDatabase();
  db.run("INSERT INTO resource_transfer_jobs(id,resource_id,link_index,provider,source_url,source_password,target_folder,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'queued',?,?)", id, resource.id, input.linkIndex, input.provider, link.url, link.password, targetFolder, now, now);
  return getResourceTransferJob(id)!;
}

export function getResourceTransferJob(id: string): ResourceTransferJob | null {
  const row = getSqliteDatabase().getRow<TransferJobRow>("SELECT * FROM resource_transfer_jobs WHERE id = ?", id);
  return row ? rowToJob(row) : null;
}

type QuarkJson = Record<string, any>;
const QUARK_PC_BASE = "https://drive-pc.quark.cn/1/clouddrive";
const QUARK_SHARE_BASE = "https://drive.quark.cn/1/clouddrive";

function loadQuarkCookie(): string {
  const cookie = getQuarkCookie().trim();
  if (cookie) return cookie;
  throw new Error("夸克登录态未配置，请先在管理后台系统设置中保存 Cookie");
}

function quarkParams(extra: Record<string, string | number> = {}): string {
  const params = new URLSearchParams({ pr: "ucpro", fr: "pc", uc_param_str: "", __t: String(Date.now()), __dt: "1000" });
  for (const [key, value] of Object.entries(extra)) params.set(key, String(value));
  return params.toString();
}

async function quarkRequest(base: string, path: string, options: { method?: "GET" | "POST"; params?: Record<string, string | number>; body?: QuarkJson } = {}): Promise<QuarkJson> {
  const url = `${base}/${path}?${quarkParams(options.params)}`;
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      accept: "application/json, text/plain, */*",
      "accept-language": "zh-CN,zh;q=0.9",
      "content-type": "application/json",
      cookie: loadQuarkCookie(),
      origin: "https://pan.quark.cn",
      referer: "https://pan.quark.cn/",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(Math.max(10_000, Number(process.env.PANHUB_TRANSFER_TIMEOUT_MS || 180_000))),
  });
  const text = await response.text();
  let payload: QuarkJson;
  try { payload = JSON.parse(text) as QuarkJson; } catch { throw new Error(`夸克接口返回非 JSON（HTTP ${response.status}）`); }
  const message = typeof payload.message === "string" ? payload.message : typeof payload.error === "string" ? payload.error : "";
  if (!response.ok || payload.status === "error" || (payload.code !== undefined && Number(payload.code) !== 0)) throw new Error(message || `夸克接口请求失败（HTTP ${response.status}）`);
  return payload;
}

async function ensureQuarkFolder(folder: string): Promise<string> {
  const parts = folder.split("/").filter(Boolean);
  let parentId = "0";
  for (const name of parts) {
    const listed = await quarkRequest(QUARK_PC_BASE, "file/sort", { params: { pdir_fid: parentId, _page: 1, _size: 1000, _fetch_total: 1, _sort: "file_name:asc" } });
    const files = Array.isArray(listed.data?.list) ? listed.data.list : [];
    const existing = files.find((item: any) => item.file_type === 0 && item.file_name === name);
    if (existing?.fid) { parentId = String(existing.fid); continue; }
    const created = await quarkRequest(QUARK_PC_BASE, "file", { method: "POST", body: { pdir_fid: parentId, file_name: name, dir_init_lock: false, dir_path: "" } });
    const fid = created.data?.fid;
    if (!fid) throw new Error(`夸克目标文件夹创建失败：${name}`);
    parentId = String(fid);
  }
  return parentId;
}

async function listQuarkFolder(folderId: string): Promise<QuarkJson[]> {
  const listed = await quarkRequest(QUARK_PC_BASE, "file/sort", {
    params: { pdir_fid: folderId, _page: 1, _size: 1000, _fetch_total: 1, _sort: "file_name:asc" },
  });
  return Array.isArray(listed.data?.list) ? listed.data.list : [];
}

function parseQuarkShare(url: string, password: string | null): { shareId: string; password: string } {
  const match = url.match(/pan\.quark\.cn\/s\/([A-Za-z0-9_-]+)/iu);
  if (!match) throw new Error("夸克分享链接格式不正确");
  let parsedPassword = password || "";
  try { const parsed = new URL(url); parsedPassword ||= parsed.searchParams.get("pwd") || parsed.searchParams.get("passcode") || ""; } catch { /* validated by the regex above */ }
  return { shareId: match[1], password: parsedPassword };
}

async function waitQuarkTask(taskId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let retryIndex = 0;
  while (Date.now() < deadline) {
    const result = await quarkRequest(QUARK_PC_BASE, "task", { params: { task_id: taskId, retry_index: retryIndex++ } });
    const status = Number(result.data?.status);
    if (status === 2) return;
    if (status === 3) throw new Error(result.data?.message || "夸克任务失败");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("夸克任务超时");
}

async function runQuarkTransfer(input: { url: string; password: string | null; name: string; targetFolder: string }): Promise<{ url: string; password: string | null }> {
  const { shareId, password } = parseQuarkShare(input.url, input.password);
  const targetFolderId = await ensureQuarkFolder(input.targetFolder);
  const existingItems = await listQuarkFolder(targetFolderId);
  if (!existingItems.length) {
    const tokenResponse = await quarkRequest(QUARK_SHARE_BASE, "share/sharepage/token", { method: "POST", body: { pwd_id: shareId, passcode: password, support_visit_limit_private_share: true } });
    const token = tokenResponse.data?.stoken;
    if (!token) throw new Error("夸克分享访问令牌获取失败，请检查链接或提取码");
    const saved = await quarkRequest(QUARK_SHARE_BASE, "share/sharepage/save", { method: "POST", body: { fid_list: [], fid_token_list: [], to_pdir_fid: targetFolderId, pwd_id: shareId, stoken: token, pdir_fid: "0", pdir_save_all: true, exclude_fids: [], scene: "link" } });
    const saveTaskId = saved.data?.task_id;
    if (saveTaskId) await waitQuarkTask(String(saveTaskId), Math.max(30_000, Number(process.env.PANHUB_TRANSFER_TIMEOUT_MS || 180_000)));
  }
  const shared = await quarkRequest(QUARK_PC_BASE, "share", { method: "POST", body: { fid_list: [targetFolderId], title: input.name, url_type: 1, expired_type: 1 } });
  const shareTaskId = shared.data?.task_id;
  if (!shareTaskId) throw new Error("夸克分享任务创建失败");
  await waitQuarkTask(String(shareTaskId), Math.max(30_000, Number(process.env.PANHUB_TRANSFER_TIMEOUT_MS || 180_000)));
  const task = await quarkRequest(QUARK_PC_BASE, "task", { params: { task_id: shareTaskId, retry_index: 0 } });
  const shareIdResult = task.data?.share_id;
  if (!shareIdResult) throw new Error("夸克分享任务完成，但未返回分享 ID");
  const details = await quarkRequest(QUARK_PC_BASE, "share/password", { method: "POST", body: { share_id: shareIdResult } });
  const shareUrl = details.data?.share_url || details.data?.url || `https://pan.quark.cn/s/${shareIdResult}`;
  if (typeof shareUrl !== "string" || !/^https?:\/\//iu.test(shareUrl)) throw new Error("夸克未返回有效分享链接");
  return { url: shareUrl, password: typeof details.data?.passcode === "string" ? details.data.passcode : null };
}

type BaiduJson = Record<string, any>;
const BAIDU_BASE = "https://pan.baidu.com";
const BAIDU_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36";

function baiduTimeoutMs(): number {
  return Math.max(10_000, Number(process.env.PANHUB_TRANSFER_TIMEOUT_MS || 180_000));
}

function cookieValue(cookie: string, name: string): string {
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`, "u"));
  return match?.[1] || "";
}

function mergeSetCookies(cookie: string, response: Response): string {
  const values = new Map<string, string>();
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0) values.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : (response.headers.get("set-cookie") || "").split(/,(?=[A-Za-z0-9_]+=)/u).filter(Boolean);
  for (const value of setCookies) {
    const separator = value.indexOf("=");
    if (separator > 0) values.set(value.slice(0, separator).trim(), value.slice(separator + 1).split(";", 1)[0].trim());
  }
  return [...values.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

class BaiduWebClient {
  cookie: string;

  constructor(cookie: string) {
    if (!cookieValue(cookie, "BDUSS") && !cookieValue(cookie, "BDUSS_BFESS")) throw new Error("百度 Cookie 中未找到 BDUSS 或 BDUSS_BFESS，请重新复制完整 Cookie 请求头");
    if (!cookieValue(cookie, "BAIDUID")) throw new Error("百度 Cookie 中未找到 BAIDUID，请重新复制完整 Cookie 请求头");
    this.cookie = cookie;
  }

  private async request(path: string, options: { method?: "GET" | "POST"; params?: Record<string, string | number>; body?: Record<string, string>; referer?: string; text?: boolean } = {}): Promise<BaiduJson | string> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options.params || {})) params.set(key, String(value));
    const url = `${BAIDU_BASE}${path}${params.size ? `?${params.toString()}` : ""}`;
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: {
        accept: options.text ? "text/html,application/xhtml+xml" : "application/json, text/plain, */*",
        "content-type": options.body ? "application/x-www-form-urlencoded; charset=UTF-8" : "application/json",
        cookie: this.cookie,
        referer: options.referer || "https://pan.baidu.com/disk/main",
        "user-agent": BAIDU_UA,
        "x-requested-with": "XMLHttpRequest",
      },
      body: options.body ? new URLSearchParams(options.body).toString() : undefined,
      signal: AbortSignal.timeout(baiduTimeoutMs()),
    });
    this.cookie = mergeSetCookies(this.cookie, response);
    const text = await response.text();
    if (options.text) {
      if (!response.ok) throw new Error(`百度接口请求失败（HTTP ${response.status}）`);
      return text;
    }
    let payload: BaiduJson;
    try { payload = JSON.parse(text) as BaiduJson; } catch { throw new Error(`百度接口 ${path} 返回非 JSON（HTTP ${response.status}）`); }
    const errno = payload.errno;
    const message = typeof payload.err_msg === "string" ? payload.err_msg : typeof payload.show_msg === "string" ? payload.show_msg : typeof payload.message === "string" ? payload.message : "";
    if (!response.ok || (errno !== undefined && Number(errno) !== 0)) throw new Error(message || `百度接口请求失败（errno ${String(errno ?? response.status)}）`);
    return payload;
  }

  async text(path: string, options: Omit<Parameters<BaiduWebClient["request"]>[1], "text"> = {}): Promise<string> {
    return await this.request(path, { ...options, text: true }) as string;
  }

  async json(path: string, options: Parameters<BaiduWebClient["request"]>[1] = {}): Promise<BaiduJson> {
    return await this.request(path, options) as BaiduJson;
  }
}

function parseBaiduShare(url: string, password: string | null): { surl: string; password: string } {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("百度分享链接格式不正确"); }
  const pathMatch = parsed.pathname.match(/\/s\/([^/]+)/iu);
  const surl = pathMatch ? pathMatch[1].replace(/^1/u, "") : parsed.searchParams.get("surl") || "";
  if (!surl) throw new Error("百度分享链接格式不正确");
  return { surl, password: password || parsed.searchParams.get("pwd") || "" };
}

function baiduLogId(cookie: string): string {
  return Buffer.from(cookieValue(cookie, "BAIDUID"), "utf8").toString("base64");
}

function extractBaiduShareData(html: string): { shareId: string; uk: string } {
  const shareId = html.match(/shareid\s*:\s*["']?(\d+)/iu)?.[1] || "";
  const uk = html.match(/share_uk\s*:\s*["']?(\d+)/iu)?.[1] || "";
  if (!shareId || !uk) throw new Error("无法从百度分享页提取分享信息，链接可能已失效或 Cookie 无效");
  return { shareId, uk };
}

async function listBaiduShareRoot(client: BaiduWebClient, shareId: string, uk: string, surl: string, sekey: string): Promise<BaiduJson[]> {
  const items: BaiduJson[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const result = await client.json("/share/list", {
      params: { shareid: shareId, uk, sekey, type: 0, root: 1, page, num: 100, order: "other", desc: 1, channel: "chunlei", web: 1, app_id: 250528, clienttype: 0 },
      referer: `${BAIDU_BASE}/s/1${surl}`,
    });
    const pageItems = Array.isArray(result.list) ? result.list : [];
    items.push(...pageItems);
    if (pageItems.length < 100) break;
  }
  return items;
}

async function loadBaiduToken(client: BaiduWebClient): Promise<string> {
  const html = await client.text("/disk/main", { referer: "https://pan.baidu.com/disk/main" });
  const token = html.match(/bdstoken["']?\s*[:=]\s*["']?([a-z0-9_-]+)["']?/iu)?.[1] || "";
  if (!token) throw new Error("百度未获取到 bdstoken，请确认 Cookie 包含 STOKEN 并重新复制");
  return token;
}

async function listBaiduDirectory(client: BaiduWebClient, path: string): Promise<BaiduJson[]> {
  const items: BaiduJson[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const options = { params: { dir: path, order: "name", page, num: 100 }, referer: "https://pan.baidu.com/disk/main" };
    let result: BaiduJson;
    try {
      result = await client.json("/api/list", options);
    } catch (error) {
      if (!/非 JSON|HTTP 5\d\d/iu.test(error instanceof Error ? error.message : String(error))) throw error;
      result = await client.json("/api/list", { ...options, method: "POST" });
    }
    const pageItems = Array.isArray(result.list) ? result.list : [];
    items.push(...pageItems);
    if (pageItems.length < 100) break;
  }
  return items;
}

async function ensureBaiduFolder(client: BaiduWebClient, folder: string, bdstoken: string, cookie: string): Promise<number> {
  const parts = folder.split("/").filter(Boolean);
  let parent = "/";
  let folderId = 0;
  for (const name of parts) {
    const full = `${parent === "/" ? "" : parent}/${name}`;
    const current = await listBaiduDirectory(client, parent);
    const existing = current.find((item) => String(item.server_filename || item.filename || "") === name && Number(item.isdir) === 1);
    if (existing) folderId = Number(existing.fs_id);
    if (!existing) {
      try {
        await client.json("/api/create", {
          method: "POST",
          params: { a: "commit", channel: "chunlei", web: 1, app_id: 250528, bdstoken, clienttype: 0, logid: baiduLogId(cookie) },
          body: { path: full, isdir: "1", rtype: "0", block_list: "[]" },
          referer: "https://pan.baidu.com/disk/main",
        });
      } catch (error) {
        const refreshed = await listBaiduDirectory(client, parent);
        const recovered = refreshed.find((item) => String(item.server_filename || item.filename || "") === name && Number(item.isdir) === 1);
        if (!recovered) throw error;
        folderId = Number(recovered.fs_id);
      }
    }
    parent = full;
  }
  if (!Number.isSafeInteger(folderId) || folderId <= 0) throw new Error("百度目标文件夹创建成功，但未找到文件夹 ID");
  return folderId;
}

async function waitForBaiduDirectoryItems(client: BaiduWebClient, path: string, minimumCount: number): Promise<BaiduJson[]> {
  const deadline = Date.now() + baiduTimeoutMs();
  let items: BaiduJson[] = [];
  while (Date.now() < deadline) {
    items = await listBaiduDirectory(client, path);
    if (items.length >= minimumCount) return items;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return items;
}

function randomBaiduPassword(): string {
  const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
  const seed = randomUUID().replace(/-/gu, "");
  return Array.from({ length: 4 }, (_, index) => alphabet[Number.parseInt(seed.slice(index * 2, index * 2 + 2), 16) % alphabet.length]).join("");
}

function normalizeBaiduShareUrl(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("百度未返回有效分享链接");
  if (/^https?:\/\//iu.test(value)) return value;
  if (value.startsWith("/")) return `${BAIDU_BASE}${value}`;
  return `${BAIDU_BASE}/s/1${value.replace(/^1/u, "")}`;
}

async function runBaiduCookieTransfer(input: { url: string; password: string | null; targetFolder: string }): Promise<{ url: string; password: string | null }> {
  const cookie = getBaiduCookie().trim();
  if (!cookie) throw new Error("百度网盘登录态未配置，请先在管理后台系统设置中保存 Cookie");
  const client = new BaiduWebClient(cookie);
  const { surl, password } = parseBaiduShare(input.url, input.password);
  const pageHtml = await client.text(`/s/1${surl}`, { referer: input.url });
  const { shareId, uk } = extractBaiduShareData(pageHtml);
  const verified = await client.json("/share/verify", {
    method: "POST",
    params: { surl, t: Date.now(), logid: baiduLogId(cookie), channel: "chunlei", web: 1, app_id: 250528, clienttype: 0 },
    body: { pwd: password, vcode: "", vcode_str: "" },
    referer: `${BAIDU_BASE}/s/1${surl}`,
  });
  const sekey = typeof verified.randsk === "string" ? decodeURIComponent(verified.randsk) : "";
  if (!sekey) throw new Error("百度分享校验未返回 sekey，请检查提取码");
  const sourceItems = await listBaiduShareRoot(client, shareId, uk, surl, sekey);
  const fsids = sourceItems.map((item) => Number(item.fs_id)).filter((id) => Number.isSafeInteger(id) && id > 0);
  if (!fsids.length) throw new Error("百度分享中没有可转存的文件");
  const bdstoken = await loadBaiduToken(client);
  const targetFolderId = await ensureBaiduFolder(client, input.targetFolder, bdstoken, cookie);
  let targetItems = await listBaiduDirectory(client, input.targetFolder);
  if (!targetItems.length) {
    await client.json("/share/transfer", {
      method: "POST",
      params: { shareid: shareId, from: uk, sekey, bdstoken: "", channel: "chunlei", web: 1, app_id: 250528, clienttype: 0 },
      body: { path: input.targetFolder, async: "2", fsidlist: JSON.stringify(fsids), type: "0" },
      referer: `${BAIDU_BASE}/s/1${surl}`,
    });
    targetItems = await waitForBaiduDirectoryItems(client, input.targetFolder, sourceItems.length);
    if (targetItems.length < sourceItems.length) throw new Error("百度转存任务超时，目标文件夹内容尚未完整刷新");
  }
  if (!targetItems.length) throw new Error("百度转存已提交，但目标文件夹中没有可分享的文件");
  const newPassword = randomBaiduPassword();
  const shared = await client.json("/share/set", {
    method: "POST",
    params: { channel: "chunlei", bdstoken, clienttype: 0, web: 1, app_id: 250528 },
    body: { fid_list: JSON.stringify([targetFolderId]), schannel: "4", channel_list: "[]", period: "0", pwd: newPassword, eflag_disable: "true" },
    referer: "https://pan.baidu.com/disk/main",
  });
  return { url: normalizeBaiduShareUrl(shared.link || shared.shorturl), password: newPassword };
}

async function deleteQuarkShareResource(url: string, password: string | null): Promise<number> {
  const { shareId, password: sharePassword } = parseQuarkShare(url, password);
  const tokenResponse = await quarkRequest(QUARK_SHARE_BASE, "share/sharepage/token", {
    method: "POST",
    body: { pwd_id: shareId, passcode: sharePassword, support_visit_limit_private_share: true },
  });
  const token = tokenResponse.data?.stoken;
  if (!token) throw new Error("夸克分享访问令牌获取失败，请检查链接或提取码");
  const detail = await quarkRequest(QUARK_SHARE_BASE, "share/sharepage/detail", {
    params: { pwd_id: shareId, stoken: token, pdir_fid: "0", _page: 1, _size: 1000, _fetch_total: 1, _sort: "file_type:asc,file_name:asc" },
  });
  const items = Array.isArray(detail.data?.list) ? detail.data.list : [];
  const fids = items.map((item: QuarkJson) => String(item.fid || "")).filter((fid: string) => /^\d+$/u.test(fid) && fid !== "0");
  if (!fids.length) throw new Error("夸克分享中没有可删除资源");
  const deleted = await quarkRequest(QUARK_PC_BASE, "file/delete", {
    method: "POST",
    body: { action_type: 2, filelist: fids, exclude_fids: [] },
  });
  const taskId = deleted.data?.task_id;
  if (taskId) await waitQuarkTask(String(taskId), baiduTimeoutMs());
  return fids.length;
}

async function deleteBaiduShareResource(url: string, password: string | null): Promise<number> {
  const cookie = getBaiduCookie().trim();
  if (!cookie) throw new Error("百度网盘登录态未配置，请先在管理后台系统设置中保存 Cookie");
  const client = new BaiduWebClient(cookie);
  const { surl, password: sharePassword } = parseBaiduShare(url, password);
  const pageHtml = await client.text(`/s/1${surl}`, { referer: url });
  const { shareId, uk } = extractBaiduShareData(pageHtml);
  const verified = await client.json("/share/verify", {
    method: "POST",
    params: { surl, t: Date.now(), logid: baiduLogId(cookie), channel: "chunlei", web: 1, app_id: 250528, clienttype: 0 },
    body: { pwd: sharePassword, vcode: "", vcode_str: "" },
    referer: `${BAIDU_BASE}/s/1${surl}`,
  });
  const sekey = typeof verified.randsk === "string" ? decodeURIComponent(verified.randsk) : "";
  if (!sekey) throw new Error("百度分享校验未返回 sekey，请检查提取码");
  const items = await listBaiduShareRoot(client, shareId, uk, surl, sekey);
  const fsids = items.map((item) => Number(item.fs_id)).filter((id) => Number.isSafeInteger(id) && id > 0);
  if (!fsids.length) throw new Error("百度分享中没有可删除资源");
  const bdstoken = await loadBaiduToken(client);
  const result = await client.json("/api/filemanager", {
    method: "POST",
    params: { opera: "delete", async: 0, channel: "chunlei", web: 1, app_id: 250528, bdstoken, logid: baiduLogId(cookie), clienttype: 0 },
    body: { filelist: JSON.stringify(fsids.map((fsId) => ({ fs_id: fsId }))) },
    referer: "https://pan.baidu.com/disk/main",
  });
  const failed = Array.isArray(result.info) ? result.info.filter((item: BaiduJson) => Number(item.errno) !== 0) : [];
  if (failed.length) throw new Error(`百度删除失败（errno ${String(failed[0].errno)}）`);
  return fsids.length;
}

export async function deleteCloudResource(input: { provider: TransferProvider; url: string; password: string | null }): Promise<{ deletedCount: number }> {
  if (input.provider === "quark") return { deletedCount: await deleteQuarkShareResource(input.url, input.password) };
  return { deletedCount: await deleteBaiduShareResource(input.url, input.password) };
}

function runBaiduBridge(payload: Record<string, unknown>): Promise<{ url: string; password: string | null }> {
  const binary = process.env.PANHUB_BAIDU_TRANSFER_BIN;
  if (!binary) return Promise.reject(new Error("百度转存适配器尚未配置：请设置 PANHUB_BAIDU_TRANSFER_BIN"));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["--json"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("百度转存适配器超时")); }, Math.max(30_000, Number(process.env.PANHUB_TRANSFER_TIMEOUT_MS || 180_000)));
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > 512 * 1024) child.kill("SIGTERM"); });
    child.stderr.on("data", (chunk) => { stderr += chunk; if (stderr.length > 32 * 1024) stderr = stderr.slice(-32 * 1024); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr || `百度转存适配器退出码 ${code}`));
      try {
        const result = JSON.parse(stdout) as { url?: unknown; password?: unknown; error?: unknown };
        if (typeof result.error === "string" && result.error) throw new Error(result.error);
        if (typeof result.url !== "string" || !/^https?:\/\//iu.test(result.url)) throw new Error("百度适配器未返回有效分享链接");
        resolve({ url: result.url, password: typeof result.password === "string" ? result.password : null });
      } catch (error) { reject(error instanceof Error ? error : new Error("百度适配器返回格式不正确")); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function executeTransfer(job: TransferJobRow): Promise<{ url: string; password: string | null }> {
  const resource = getManagedResource(job.resource_id);
  if (!resource) throw new Error("资源已不存在");
  const link = resource.links[job.link_index];
  if (!link || link.url !== job.source_url) throw new Error("资源链接已被修改，请重新发起转存");
  if (job.provider === "quark") return runQuarkTransfer({ url: link.url, password: link.password, name: resource.name, targetFolder: job.target_folder });
  if (getBaiduCookie().trim()) return runBaiduCookieTransfer({ url: link.url, password: link.password, targetFolder: job.target_folder });
  return runBaiduBridge({ url: link.url, password: link.password, name: resource.name, targetFolder: job.target_folder });
}

/** Start a queued job in the current server process. The DB state makes this idempotent. */
export async function processResourceTransferJob(id: string): Promise<void> {
  const db = getSqliteDatabase();
  const now = Date.now();
  const claimed = db.run("UPDATE resource_transfer_jobs SET status='running',started_at=?,updated_at=? WHERE id=? AND status='queued'", now, now, id);
  if (!claimed.changes) return;
  const row = db.getRow<TransferJobRow>("SELECT * FROM resource_transfer_jobs WHERE id=?", id);
  if (!row) return;
  try {
    const replacement = await executeTransfer(row);
    replaceManagedResourceLink({ resourceId: row.resource_id, linkIndex: row.link_index, expectedUrl: row.source_url, replacement: { type: row.provider, url: replacement.url, password: replacement.password } as Link, transferJobId: row.id, provider: row.provider });
    const finishedAt = Date.now();
    db.run("UPDATE resource_transfer_jobs SET status='completed',replacement_url=?,replacement_password=?,finished_at=?,updated_at=? WHERE id=?", replacement.url, replacement.password, finishedAt, finishedAt, id);
  } catch (error) {
    const finishedAt = Date.now();
    db.run("UPDATE resource_transfer_jobs SET status='failed',error_message=?,finished_at=?,updated_at=? WHERE id=?", safeError(error), finishedAt, finishedAt, id);
  }
}
