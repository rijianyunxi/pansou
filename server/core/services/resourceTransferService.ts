import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { getSqliteDatabase } from "../storage/sqlite";
import type { Link } from "../types/models";
import { getManagedResource, replaceManagedResourceLink } from "./managedResourceService";
import { getQuarkCookie } from "./cloudAccountService";

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
  const tokenResponse = await quarkRequest(QUARK_SHARE_BASE, "share/sharepage/token", { method: "POST", body: { pwd_id: shareId, passcode: password, support_visit_limit_private_share: true } });
  const token = tokenResponse.data?.stoken;
  if (!token) throw new Error("夸克分享访问令牌获取失败，请检查链接或提取码");
  const saved = await quarkRequest(QUARK_SHARE_BASE, "share/sharepage/save", { method: "POST", body: { fid_list: [], fid_token_list: [], to_pdir_fid: targetFolderId, pwd_id: shareId, stoken: token, pdir_fid: "0", pdir_save_all: true, exclude_fids: [], scene: "link" } });
  const saveTaskId = saved.data?.task_id;
  if (saveTaskId) await waitQuarkTask(String(saveTaskId), Math.max(30_000, Number(process.env.PANHUB_TRANSFER_TIMEOUT_MS || 180_000)));
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
