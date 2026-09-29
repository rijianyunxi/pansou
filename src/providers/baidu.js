/**
 * 百度网盘 provider。
 *
 * 能力：链接校验、转存到自己网盘、列出自己网盘目录、同名资源去重、
 *       创建分享链接、按分享链接删除自己网盘中的资源。
 *
 * 说明：走的是百度网盘 Web 端（Cookie）接口，需要完整 Cookie
 * （BDUSS / BDUSS_BFESS + BAIDUID + STOKEN）。接口可能随官方改版失效。
 */
import { WangpanError, cookieValue, mergeSetCookies, delay, httpRequest } from "../lib/util.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const BASE = () => process.env.BAIDU_BASE || "https://pan.baidu.com";
const APP_ID = "250528";

/** 百度用到的所有上游域名（用于连接预热）。 */
export function baiduBases() {
  return [BASE()];
}

/** 百度常见错误码 → 中文说明。 */
const ERROR_TEXT = {
  "-1": "链接错误、已失效或缺少提取码",
  "-6": "Cookie 无效或不完整",
  "-7": "文件已删除或不存在",
  "-9": "提取码错误",
  "-10": "网盘容量不足",
  "-62": "操作过于频繁，请稍后再试",
  "2": "目标目录不存在",
  "4": "目标目录中存在同名文件",
  "12": "文件数超过单次限制",
  "105": "所访问的页面不存在",
};

function baiduErrorText(errno) {
  return ERROR_TEXT[String(errno)] || `百度接口错误（errno ${errno}）`;
}

/** 从百度分享链接解析 surl 与提取码。 */
export function parseBaiduShareUrl(url, password = null) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new WangpanError("百度分享链接格式不正确", { provider: "baidu" });
  }
  const pathMatch = parsed.pathname.match(/\/s\/([^/]+)/iu);
  const surl = pathMatch ? pathMatch[1].replace(/^1/u, "") : parsed.searchParams.get("surl") || "";
  if (!surl) throw new WangpanError("百度分享链接格式不正确，应形如 https://pan.baidu.com/s/1xxxxxx", { provider: "baidu" });
  return { surl, password: password || parsed.searchParams.get("pwd") || "" };
}

export function isBaiduShareUrl(url) {
  return /pan\.baidu\.com\/s\//iu.test(String(url || ""));
}

export class BaiduClient {
  /** @param {{ cookie?: string }} options */
  constructor({ cookie } = {}) {
    this.cookie = String(cookie || process.env.BAIDU_COOKIE || "").trim();
    this.bdstoken = "";
    /** 每个上游请求的耗时记录，用于诊断性能瓶颈。 */
    this.trace = [];
  }

  /** 记录一步耗时，供上层做性能诊断。 */
  #record(step, ms) {
    this.trace.push({ step, ms });
  }

  requireLogin() {
    if (!this.cookie) throw new WangpanError("百度登录态未配置，请设置 BAIDU_COOKIE", { provider: "baidu" });
    if (!cookieValue(this.cookie, "BDUSS") && !cookieValue(this.cookie, "BDUSS_BFESS")) {
      throw new WangpanError("百度 Cookie 中缺少 BDUSS / BDUSS_BFESS", { provider: "baidu" });
    }
    if (!cookieValue(this.cookie, "BAIDUID")) {
      throw new WangpanError("百度 Cookie 中缺少 BAIDUID", { provider: "baidu" });
    }
  }

  #logId() {
    return Buffer.from(cookieValue(this.cookie, "BAIDUID"), "utf8").toString("base64");
  }

  async #request(path, { method = "GET", params = {}, body = null, referer = `${BASE()}/disk/main`, text = false, step = null } = {}) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) search.set(key, String(value));
    const url = `${BASE()}${path}${search.size ? `?${search.toString()}` : ""}`;
    const startedAt = Date.now();
    let response;
    try {
      response = await httpRequest(url, {
        method,
        headers: {
          accept: text ? "text/html,application/xhtml+xml" : "application/json, text/plain, */*",
          "content-type": body ? "application/x-www-form-urlencoded; charset=UTF-8" : "application/json",
          cookie: this.cookie,
          referer,
          "user-agent": UA,
          "x-requested-with": "XMLHttpRequest",
        },
        body: body ? new URLSearchParams(body).toString() : undefined,
      });
    } finally {
      // 放在 finally 里，超时/失败的那一步也能被记录下来
      this.#record(step || path, Date.now() - startedAt);
    }
    const { ok, status, headers, body: raw } = response;
    this.cookie = mergeSetCookies(this.cookie, headers);
    if (text) {
      if (!ok) throw new WangpanError(`百度接口 ${path} 请求失败（HTTP ${status}）`, { provider: "baidu" });
      return raw;
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new WangpanError(`百度接口 ${path} 返回非 JSON（HTTP ${status}）`, { provider: "baidu" });
    }
    const errno = payload?.errno;
    if (!ok || (errno !== undefined && Number(errno) !== 0)) {
      throw new WangpanError(payload?.err_msg || payload?.show_msg || baiduErrorText(errno ?? status), {
        code: errno ?? status,
        provider: "baidu",
      });
    }
    return payload;
  }

  /** 获取 bdstoken（写操作前置）。 */
  async loadToken() {
    this.requireLogin();
    if (this.bdstoken) return this.bdstoken;
    const payload = await this.#request("/api/gettemplatevariable", {
      params: {
        clienttype: 0,
        app_id: 38824127,
        web: 1,
        fields: JSON.stringify(["bdstoken", "token", "uk", "isdocuser", "servertime"]),
      },
      step: "取 bdstoken",
    });
    const token = payload?.result?.bdstoken;
    if (!token) throw new WangpanError("百度未获取到 bdstoken，Cookie 可能已过期", { provider: "baidu" });
    this.bdstoken = token;
    return token;
  }

  /** 解析分享页，拿到 shareid 与分享者 uk。 */
  async resolveShareMeta(surl, refererUrl) {
    const html = await this.#request(`/s/1${surl}`, { text: true, referer: refererUrl, step: "解析分享页" });
    const shareId = html.match(/shareid\s*:\s*["']?(\d+)/iu)?.[1] || "";
    const uk = html.match(/share_uk\s*:\s*["']?(\d+)/iu)?.[1] || "";
    if (!shareId || !uk) {
      throw new WangpanError("无法从分享页提取分享信息，链接可能已失效或 Cookie 无效", { provider: "baidu" });
    }
    return { shareId, uk };
  }

  /** 提交提取码，换取 sekey（randsk）。 */
  async verifyShare(surl, sharePassword) {
    const payload = await this.#request("/share/verify", {
      method: "POST",
      params: { surl, t: Date.now(), logid: this.#logId(), channel: "chunlei", web: 1, app_id: APP_ID, clienttype: 0 },
      body: { pwd: sharePassword || "", vcode: "", vcode_str: "" },
      referer: `${BASE()}/s/1${surl}`,
      step: "校验提取码",
    });
    const randsk = payload?.randsk;
    if (!randsk) throw new WangpanError("百度分享校验未返回 sekey，请检查提取码", { provider: "baidu" });
    return decodeURIComponent(randsk);
  }

  /** 列出分享根目录内容。 */
  async listShareRoot(shareId, uk, surl, sekey) {
    const items = [];
    for (let page = 1; page <= 50; page += 1) {
      const payload = await this.#request("/share/list", {
        params: {
          shareid: shareId,
          uk,
          sekey,
          type: 0,
          root: 1,
          page,
          num: 100,
          order: "other",
          desc: 1,
          channel: "chunlei",
          web: 1,
          app_id: APP_ID,
          clienttype: 0,
        },
        referer: `${BASE()}/s/1${surl}`,
        step: "读分享列表",
      });
      const pageItems = Array.isArray(payload?.list) ? payload.list : [];
      items.push(...pageItems);
      if (pageItems.length < 100) break;
    }
    return items;
  }

  /**
   * 解析分享，拿到后续所有操作都要用的最小上下文。
   *
   * 抽成单独一步是为了**复用**：勾选去重时，先解析一遍分享判断是否已存在，
   * 未命中再转存。若转存时重新解析，就会白跑「解析分享页 + 校验提取码 + 读分享列表」
   * 三个网络来回（百度这三步都是串行的，代价约 400~900ms）。
   */
  async #resolveShare(url, password = null) {
    const { surl, password: sharePassword } = parseBaiduShareUrl(url, password);
    const { shareId, uk } = await this.resolveShareMeta(surl, url);
    const sekey = await this.verifyShare(surl, sharePassword);
    const items = await this.listShareRoot(shareId, uk, surl, sekey);
    return { surl, shareId, uk, sekey, items };
  }

  /**
   * 能力 1：校验分享链接是否有效，并返回根目录文件清单。
   * @returns {Promise<{valid:boolean, reason?:string, fileCount:number, files:Array, context:object}>}
   *          context 为可直接传给 saveShare 的复用上下文（不对外暴露，见 index.js）
   */
  async validateShare(url, password = null) {
    try {
      const context = await this.#resolveShare(url, password);
      const { items } = context;
      return {
        valid: true,
        title: "",
        fileCount: items.length,
        files: items.map((item) => ({
          fsId: String(item.fs_id || ""),
          name: item.server_filename || "",
          size: Number(item.size || 0),
          isDir: Boolean(item.isdir),
          md5: item.md5 || "",
        })),
        shareId: context.shareId,
        uk: context.uk,
        sekey: context.sekey,
        surl: context.surl,
        context,
      };
    } catch (error) {
      return { valid: false, reason: error?.message || "百度分享校验失败", fileCount: 0, files: [] };
    }
  }

  /**
   * 能力 2：把分享内容转存到自己的网盘。
   * @param {object} options
   * @param {string} [options.toDir] 目标目录路径，默认 "/"
   * @param {boolean} [options.autoShare] 转存成功后，为自己网盘里刚保存的内容生成分享链接
   * @param {object|null} [options.shareContext] 已解析好的分享上下文（来自 validateShare），
   *        传入可省掉「解析分享页 + 校验提取码 + 读分享列表」三个网络来回
   * @returns {Promise<{saved:boolean, count:number, target:string, names:string[], share:object|null}>}
   */
  async saveShare(url, password = null, { toDir = "/", autoShare = false, shareContext = null } = {}) {
    const { surl, shareId, uk, sekey, items } = shareContext || (await this.#resolveShare(url, password));
    const fsIds = items.map((item) => Number(item.fs_id)).filter((id) => Number.isSafeInteger(id) && id > 0);
    if (!fsIds.length) throw new WangpanError("百度分享中没有可转存的文件", { provider: "baidu" });
    const names = items.map((item) => item.server_filename || "").filter(Boolean);

    const bdstoken = await this.loadToken();
    const result = await this.#request("/share/transfer", {
      method: "POST",
      params: {
        shareid: shareId,
        from: uk,
        sekey,
        ondup: "newcopy",
        async: 0,
        channel: "chunlei",
        web: 1,
        app_id: APP_ID,
        bdstoken,
        logid: this.#logId(),
        clienttype: 0,
      },
      body: { fsidlist: JSON.stringify(fsIds), path: toDir },
      referer: `${BASE()}/s/1${surl}`,
      step: "转存",
    });
    const failed = Array.isArray(result?.info) ? result.info.filter((item) => Number(item.errno) !== 0) : [];
    if (failed.length) throw new WangpanError(baiduErrorText(failed[0].errno), { code: failed[0].errno, provider: "baidu" });

    // 转存会生成新的 fs_id，回到目标目录按名称找回后再分享
    const share = autoShare ? await this.#shareSavedByName(names, toDir) : null;
    return { saved: true, count: fsIds.length, target: toDir, names, share };
  }

  /** 在目标目录里按名称找回刚转存进来的条目，并生成分享链接。 */
  async #shareSavedByName(names, dir) {
    if (!names.length) return null;
    const mine = await this.listDir(dir);
    const wanted = new Set(names);
    let matched = mine.filter((item) => wanted.has(item.name));
    if (!matched.length) matched = mine.filter((item) => names.some((name) => item.name.startsWith(name)));
    if (!matched.length) return null;
    return this.createShare(matched.map((item) => item.fsId));
  }

  /** 列出自己网盘某个目录下的文件。 */
  async listDir(dir = "/") {
    const bdstoken = await this.loadToken();
    const payload = await this.#request("/api/list", {
      params: { order: "time", desc: 1, showempty: 0, web: 1, page: 1, num: 1000, dir, bdstoken },
      step: "列目录",
    });
    const list = Array.isArray(payload?.list) ? payload.list : [];
    return list.map((item) => ({
      fsId: String(item.fs_id || ""),
      name: item.server_filename || "",
      size: Number(item.size || 0),
      isDir: Boolean(item.isdir),
      md5: item.md5 || "",
      path: item.path || "",
    }));
  }

  /**
   * 纯比对逻辑：把分享条目与"我网盘目录"条目匹配（无网络请求）。
   * 优先 md5 精确匹配，退化到 名称 + 大小。拆出来是为了支持并行执行。
   */
  matchExisting(files, mine) {
    const byMd5 = new Map();
    const byKey = new Map();
    for (const item of mine) {
      if (item.isDir) continue;
      if (item.md5) byMd5.set(item.md5, item);
      byKey.set(`${String(item.name).trim()}::${item.size}`, item);
    }
    const matched = [];
    const missing = [];
    for (const file of files) {
      if (file.isDir) {
        missing.push(file);
        continue;
      }
      const hit = (file.md5 && byMd5.get(file.md5)) || byKey.get(`${String(file.name).trim()}::${file.size}`);
      if (hit) matched.push({ share: file, mine: hit });
      else missing.push(file);
    }
    return { exists: matched.length > 0, matched, missing };
  }

  /**
   * 能力 3：判断分享中的文件是否已存在于自己网盘（优先 md5，其次 名称 + 大小）。
   * @returns {Promise<{exists:boolean, matched:Array, missing:Array}>}
   */
  async findExisting(files, dir = "/") {
    return this.matchExisting(files, await this.listDir(dir));
  }

  /** 对自己网盘中的文件创建分享链接。 */
  async createShare(fsIds, { period = 0, password = "" } = {}) {
    const bdstoken = await this.loadToken();
    const pwd = password || randomPassword();
    const payload = await this.#request("/share/set", {
      method: "POST",
      params: { channel: "chunlei", bdstoken, clienttype: 0, app_id: APP_ID, web: 1 },
      body: {
        period: String(period),
        pwd,
        eflag_disable: "true",
        channel_list: "[]",
        schannel: "4",
        fid_list: JSON.stringify(fsIds.map((id) => Number(id))),
      },
      step: "创建分享",
    });
    if (!payload?.link) throw new WangpanError("百度创建分享未返回链接", { provider: "baidu" });
    return { url: payload.link, password: pwd, shareId: String(payload.shareid || "") };
  }

  /** 从自己网盘中删除文件（按 fs_id）。 */
  async deleteFiles(fsIds) {
    const bdstoken = await this.loadToken();
    if (!fsIds.length) return { deleted: 0 };
    const payload = await this.#request("/api/filemanager", {
      method: "POST",
      params: {
        opera: "delete",
        async: 0,
        channel: "chunlei",
        web: 1,
        app_id: APP_ID,
        bdstoken,
        logid: this.#logId(),
        clienttype: 0,
      },
      body: { filelist: JSON.stringify(fsIds.map((fsId) => ({ fs_id: Number(fsId) }))) },
      step: "删除",
    });
    const failed = Array.isArray(payload?.info) ? payload.info.filter((item) => Number(item.errno) !== 0) : [];
    if (failed.length) throw new WangpanError(baiduErrorText(failed[0].errno), { code: failed[0].errno, provider: "baidu" });
    return { deleted: fsIds.length };
  }

  /**
   * 按"我自己的分享链接"删除我网盘里的资源：
   * 解析分享内的 fs_id（自己的分享，fs_id 即网盘内文件 id），再执行删除。
   */
  async deleteByShareUrl(url, password = null) {
    const { items } = await this.#resolveShare(url, password);
    const fsIds = items.map((item) => String(item.fs_id || "")).filter((id) => /^\d+$/u.test(id));
    if (!fsIds.length) throw new WangpanError("该分享中没有可删除的资源", { provider: "baidu" });
    const { deleted } = await this.deleteFiles(fsIds);
    return { deleted, fsIds };
  }

  /** 校验 Cookie 是否可用（尝试列根目录）。 */
  async ping() {
    const list = await this.listDir("/");
    return { ok: true, count: list.length };
  }
}

function randomPassword() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 4; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export { delay };
