import { getBaiduCookie, getQuarkCookie } from "./cloudAccountService";

export type CloudProvider = "quark" | "baidu";

type CloudJson = Record<string, any>;
const QUARK_PC_BASE = "https://drive-pc.quark.cn/1/clouddrive";
const QUARK_SHARE_BASE = "https://drive.quark.cn/1/clouddrive";
const BAIDU_BASE = "https://pan.baidu.com";
const BAIDU_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36";
const CLOUD_DELETE_TIMEOUT_MS = 180_000;

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

async function quarkRequest(base: string, path: string, options: { method?: "GET" | "POST"; params?: Record<string, string | number>; body?: CloudJson } = {}): Promise<CloudJson> {
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
    signal: AbortSignal.timeout(CLOUD_DELETE_TIMEOUT_MS),
  });
  const text = await response.text();
  let payload: CloudJson;
  try { payload = JSON.parse(text) as CloudJson; } catch { throw new Error(`夸克接口返回非 JSON（HTTP ${response.status}）`); }
  const message = typeof payload.message === "string" ? payload.message : typeof payload.error === "string" ? payload.error : "";
  if (!response.ok || payload.status === "error" || (payload.code !== undefined && Number(payload.code) !== 0)) throw new Error(message || `夸克接口请求失败（HTTP ${response.status}）`);
  return payload;
}

function parseQuarkShare(url: string, password: string | null): { shareId: string; password: string } {
  const match = url.match(/pan\.quark\.cn\/s\/([A-Za-z0-9_-]+)/iu);
  if (!match) throw new Error("夸克分享链接格式不正确");
  let parsedPassword = password || "";
  try { const parsed = new URL(url); parsedPassword ||= parsed.searchParams.get("pwd") || parsed.searchParams.get("passcode") || ""; } catch { /* validated by the regex above */ }
  return { shareId: match[1], password: parsedPassword };
}

async function waitQuarkTask(taskId: string): Promise<void> {
  const deadline = Date.now() + CLOUD_DELETE_TIMEOUT_MS;
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

  private async request(path: string, options: { method?: "GET" | "POST"; params?: Record<string, string | number>; body?: Record<string, string>; referer?: string; text?: boolean } = {}): Promise<CloudJson | string> {
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
      signal: AbortSignal.timeout(CLOUD_DELETE_TIMEOUT_MS),
    });
    this.cookie = mergeSetCookies(this.cookie, response);
    const text = await response.text();
    if (options.text) {
      if (!response.ok) throw new Error(`百度接口请求失败（HTTP ${response.status}）`);
      return text;
    }
    let payload: CloudJson;
    try { payload = JSON.parse(text) as CloudJson; } catch { throw new Error(`百度接口 ${path} 返回非 JSON（HTTP ${response.status}）`); }
    const errno = payload.errno;
    const message = typeof payload.err_msg === "string" ? payload.err_msg : typeof payload.show_msg === "string" ? payload.show_msg : typeof payload.message === "string" ? payload.message : "";
    if (!response.ok || (errno !== undefined && Number(errno) !== 0)) throw new Error(message || `百度接口请求失败（errno ${String(errno ?? response.status)}）`);
    return payload;
  }

  async text(path: string, options: Omit<Parameters<BaiduWebClient["request"]>[1], "text"> = {}): Promise<string> {
    return await this.request(path, { ...options, text: true }) as string;
  }

  async json(path: string, options: Parameters<BaiduWebClient["request"]>[1] = {}): Promise<CloudJson> {
    return await this.request(path, options) as CloudJson;
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

async function listBaiduShareRoot(client: BaiduWebClient, shareId: string, uk: string, surl: string, sekey: string): Promise<CloudJson[]> {
  const items: CloudJson[] = [];
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
  const fids = items.map((item: CloudJson) => String(item.fid || "")).filter((fid: string) => /^\d+$/u.test(fid) && fid !== "0");
  if (!fids.length) throw new Error("夸克分享中没有可删除资源");
  const deleted = await quarkRequest(QUARK_PC_BASE, "file/delete", {
    method: "POST",
    body: { action_type: 2, filelist: fids, exclude_fids: [] },
  });
  const taskId = deleted.data?.task_id;
  if (taskId) await waitQuarkTask(String(taskId));
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
  const failed = Array.isArray(result.info) ? result.info.filter((item: CloudJson) => Number(item.errno) !== 0) : [];
  if (failed.length) throw new Error(`百度删除失败（errno ${String(failed[0].errno)}）`);
  return fsids.length;
}

export async function deleteCloudResource(input: { provider: CloudProvider; url: string; password: string | null }): Promise<{ deletedCount: number }> {
  if (input.provider === "quark") return { deletedCount: await deleteQuarkShareResource(input.url, input.password) };
  return { deletedCount: await deleteBaiduShareResource(input.url, input.password) };
}
