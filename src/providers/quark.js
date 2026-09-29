/**
 * 夸克网盘 provider。
 *
 * 能力：链接校验、转存到自己网盘、列出自己网盘目录、同名资源去重、
 *       创建分享链接、按分享链接删除自己网盘中的资源。
 *
 * 说明：夸克没有公开的第三方 API，这里走的是 Web 端（Cookie）接口，
 * 接口可能随官方改版失效。所有域名可通过环境变量覆盖。
 */
import { WangpanError, cookieValue, delay, httpRequest } from "../lib/util.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const SHARE_BASE = () => process.env.QUARK_SHARE_BASE || "https://drive.quark.cn/1/clouddrive";
const PC_BASE = () => process.env.QUARK_PC_BASE || "https://drive-pc.quark.cn/1/clouddrive";

/** 从夸克分享链接解析 pwd_id 与提取码。 */
export function parseQuarkShareUrl(url, password = null) {
  const match = String(url || "").match(/pan\.quark\.cn\/s\/([A-Za-z0-9_-]+)/iu);
  if (!match) throw new WangpanError("夸克分享链接格式不正确，应形如 https://pan.quark.cn/s/xxxxxx", { provider: "quark" });
  let passcode = password || "";
  try {
    const parsed = new URL(url);
    passcode ||= parsed.searchParams.get("pwd") || parsed.searchParams.get("passcode") || "";
  } catch {
    /* 正则已保证基本格式 */
  }
  return { pwdId: match[1], passcode };
}

/** 判断一个 URL 是否像夸克分享链接。 */
export function isQuarkShareUrl(url) {
  return /pan\.quark\.cn\/s\//iu.test(String(url || ""));
}

/**
 * 判断是否为有效的夸克 fid。
 *
 * 注意：夸克 fid 是 32 位**十六进制**串（如 4208105bd6034246836d3671829d9349），
 * 不是纯数字——用 /^\d+$/ 校验会把绝大多数 fid 误杀。这里只排除空值与根目录 "0"。
 */
export function isQuarkFid(fid) {
  return typeof fid === "string" && fid.length > 0 && fid !== "0" && /^[0-9A-Za-z_-]+$/u.test(fid);
}

export class QuarkClient {
  /** @param {{ cookie?: string }} options */
  constructor({ cookie } = {}) {
    this.cookie = String(cookie || process.env.QUARK_COOKIE || "").trim();
  }

  requireLogin() {
    if (!this.cookie) {
      throw new WangpanError("夸克登录态未配置，请设置 QUARK_COOKIE", { provider: "quark" });
    }
  }

  #params(extra = {}) {
    const params = new URLSearchParams({
      pr: "ucpro",
      fr: "pc",
      uc_param_str: "",
      __t: String(Date.now()),
      __dt: "1000",
    });
    for (const [key, value] of Object.entries(extra)) params.set(key, String(value));
    return params.toString();
  }

  async #request(base, path, { method = "GET", params = {}, body = null, referer = "https://pan.quark.cn/" } = {}) {
    const url = `${base}/${path}?${this.#params(params)}`;
    const { ok, status, body: raw } = await httpRequest(url, {
      method,
      headers: {
        accept: "application/json, text/plain, */*",
        "accept-language": "zh-CN,zh;q=0.9",
        "content-type": "application/json",
        cookie: this.cookie,
        origin: "https://pan.quark.cn",
        referer,
        "user-agent": UA,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new WangpanError(`夸克接口 ${path} 返回非 JSON（HTTP ${status}）`, { provider: "quark" });
    }
    const code = Number(payload?.code);
    const success = ok && payload?.status !== "error" && (payload?.code === undefined || code === 0);
    if (!success) {
      const message = payload?.message || payload?.error || `夸克接口请求失败（HTTP ${status}）`;
      throw new WangpanError(message, { code: Number.isFinite(code) ? code : null, provider: "quark" });
    }
    return payload;
  }

  /** 轮询夸克异步任务，直到完成（status=2）或失败（status=3）。 */
  async waitTask(taskId, { maxWaitMs = 120_000, intervalMs = 1000 } = {}) {
    const deadline = Date.now() + maxWaitMs;
    let retryIndex = 0;
    while (Date.now() < deadline) {
      const result = await this.#request(PC_BASE(), "task", { params: { task_id: taskId, retry_index: retryIndex++ } });
      const status = Number(result?.data?.status);
      if (status === 2) return result.data;
      if (status === 3) throw new WangpanError(result?.data?.message || "夸克任务执行失败", { provider: "quark" });
      await delay(intervalMs);
    }
    throw new WangpanError("夸克任务超时", { provider: "quark" });
  }

  /** 获取分享访问令牌（stoken）。这一步失败通常意味着链接失效或提取码错误。 */
  async shareToken(pwdId, passcode) {
    const response = await this.#request(SHARE_BASE(), "share/sharepage/token", {
      method: "POST",
      body: { pwd_id: pwdId, passcode: passcode || "", support_visit_limit_private_share: true },
    });
    const stoken = response?.data?.stoken;
    if (!stoken) throw new WangpanError("夸克分享令牌获取失败，请检查链接或提取码", { provider: "quark" });
    return stoken;
  }

  /** 获取分享目录内容。 */
  async shareDetail(pwdId, stoken, pdirFid = "0") {
    return this.#request(SHARE_BASE(), "share/sharepage/detail", {
      params: {
        pwd_id: pwdId,
        stoken,
        pdir_fid: pdirFid,
        _page: 1,
        _size: 200,
        _fetch_total: 1,
        _sort: "file_type:asc,file_name:asc",
      },
      referer: `https://pan.quark.cn/s/${pwdId}`,
    });
  }

  /**
   * 能力 1：校验分享链接是否有效，并返回根目录文件清单。
   * @returns {Promise<{valid:boolean, reason?:string, title:string, fileCount:number, files:Array}>}
   */
  async validateShare(url, password = null) {
    const { pwdId, passcode } = parseQuarkShareUrl(url, password);
    try {
      const stoken = await this.shareToken(pwdId, passcode);
      const detail = await this.shareDetail(pwdId, stoken);
      const list = Array.isArray(detail?.data?.list) ? detail.data.list : [];
      return {
        valid: true,
        title: detail?.data?.share?.title || "",
        fileCount: Number(detail?.data?.share?.file_num ?? list.length),
        files: list.map((item) => ({
          fid: String(item.fid || ""),
          name: item.file_name || item.filename || "",
          size: Number(item.size || 0),
          isDir: Boolean(item.dir),
          shareFidToken: item.share_fid_token || "",
        })),
        stoken,
        pwdId,
      };
    } catch (error) {
      return { valid: false, reason: error?.message || "夸克分享校验失败", title: "", fileCount: 0, files: [] };
    }
  }

  /**
   * 能力 2：把分享内容转存到自己的网盘。
   * @param {object} options
   * @param {string} [options.toPdirFid] 目标目录 fid，默认根目录 "0"
   * @param {boolean} [options.autoShare] 转存成功后，为自己网盘里刚保存的内容生成分享链接
   * @returns {Promise<{saved:boolean, taskId:string|null, toPdirFid:string, files:number, names:string[], share:object|null}>}
   */
  async saveShare(url, password = null, { toPdirFid = "0", autoShare = false } = {}) {
    this.requireLogin();
    const { pwdId, passcode } = parseQuarkShareUrl(url, password);
    const stoken = await this.shareToken(pwdId, passcode);
    const detail = await this.shareDetail(pwdId, stoken);
    const list = Array.isArray(detail?.data?.list) ? detail.data.list : [];
    if (!list.length) throw new WangpanError("夸克分享中没有可转存的文件", { provider: "quark" });

    const fidList = list.map((item) => String(item.fid));
    const fidTokenList = list.map((item) => item.share_fid_token || "");
    const names = list.map((item) => item.file_name || item.filename || "").filter(Boolean);

    const response = await this.#request(PC_BASE(), "share/sharepage/save", {
      method: "POST",
      body: {
        fid_list: fidList,
        fid_token_list: fidTokenList,
        pdir_fid: "0",
        pwd_id: pwdId,
        scene: "link",
        stoken,
        to_pdir_fid: toPdirFid,
      },
      referer: `https://pan.quark.cn/s/${pwdId}`,
    });
    const taskId = response?.data?.task_id ? String(response.data.task_id) : null;
    if (taskId) await this.waitTask(taskId);

    // 转存会在我网盘里生成**新的 fid**，所以必须回到目标目录按名称找回，不能复用分享里的 fid
    const share = autoShare ? await this.#shareSavedByName(names, toPdirFid) : null;
    return { saved: true, taskId, toPdirFid, files: list.length, names, share };
  }

  /** 在目标目录里按名称找回刚转存进来的条目，并生成分享链接。 */
  async #shareSavedByName(names, pdirFid) {
    if (!names.length) return null;
    const mine = await this.listDir(pdirFid);
    const wanted = new Set(names);
    let matched = mine.filter((item) => wanted.has(item.name));
    if (!matched.length) matched = mine.filter((item) => names.some((name) => item.name.startsWith(name)));
    if (!matched.length) return null;
    return this.createShare(matched.map((item) => item.fid), {});
  }

  /** 列出自己网盘某个目录下的文件。 */
  async listDir(pdirFid = "0") {
    this.requireLogin();
    const response = await this.#request(PC_BASE(), "file/sort", {
      params: {
        pdir_fid: pdirFid,
        _page: 1,
        _size: 200,
        _fetch_total: 1,
        _sort: "file_type:asc,updated_at:desc",
      },
    });
    const list = Array.isArray(response?.data?.list) ? response.data.list : [];
    return list.map((item) => ({
      fid: String(item.fid || ""),
      name: item.file_name || "",
      size: Number(item.size || 0),
      isDir: Boolean(item.dir),
      updatedAt: Number(item.updated_at || 0),
    }));
  }

  /**
   * 能力 3：判断分享中的文件是否已存在于自己网盘（按 名称 + 大小 匹配）。
   * @returns {Promise<{exists:boolean, matched:Array, missing:Array}>}
   */
  async findExisting(files, pdirFid = "0") {
    const mine = await this.listDir(pdirFid);
    const key = (name, size) => `${String(name).trim()}::${Number(size)}`;
    const index = new Map(mine.map((item) => [key(item.name, item.size), item]));
    const matched = [];
    const missing = [];
    for (const file of files) {
      const hit = index.get(key(file.name, file.size));
      if (hit) matched.push({ share: file, mine: hit });
      else missing.push(file);
    }
    return { exists: matched.length > 0, matched, missing };
  }

  /** 对自己网盘中的文件创建分享链接。 */
  async createShare(fids, { title = "PanHub 分享", expiredType = 1 } = {}) {
    this.requireLogin();
    const created = await this.#request(PC_BASE(), "share", {
      method: "POST",
      body: { fid_list: fids, title, url_type: 1, expired_type: expiredType, expire_time: 0 },
    });
    let shareId = created?.data?.task_resp?.data?.share_id || created?.data?.share_id || "";
    const taskId = created?.data?.task_id;
    if (!shareId && taskId) {
      const task = await this.waitTask(String(taskId));
      shareId = task?.share_id || task?.task_resp?.data?.share_id || "";
    }
    if (!shareId) throw new WangpanError("夸克创建分享未返回 share_id", { provider: "quark" });
    const passwordInfo = await this.#request(PC_BASE(), "share/password", {
      method: "POST",
      body: { share_id: shareId },
    });
    return {
      shareId,
      url: passwordInfo?.data?.share_url || `https://pan.quark.cn/s/${shareId}`,
      password: passwordInfo?.data?.share_pwd || "",
    };
  }

  /** 从自己网盘中删除文件（按 fid）。 */
  async deleteFiles(fids) {
    this.requireLogin();
    if (!fids.length) return { deleted: 0 };
    const response = await this.#request(PC_BASE(), "file/delete", {
      method: "POST",
      body: { action_type: 2, filelist: fids, exclude_fids: [] },
    });
    const taskId = response?.data?.task_id;
    if (taskId) await this.waitTask(String(taskId));
    return { deleted: fids.length };
  }

  /**
   * 按"我自己的分享链接"删除我网盘里的资源：
   * 解析分享内的 fid（自己的分享，fid 即网盘内 fid），再执行删除。
   */
  async deleteByShareUrl(url, password = null) {
    const { pwdId, passcode } = parseQuarkShareUrl(url, password);
    const stoken = await this.shareToken(pwdId, passcode);
    const detail = await this.shareDetail(pwdId, stoken);
    const list = Array.isArray(detail?.data?.list) ? detail.data.list : [];
    if (!list.length) throw new WangpanError("该分享根目录为空，没有可删除的资源", { provider: "quark" });

    const targets = list
      .map((item) => ({ fid: String(item.fid || ""), name: item.file_name || item.filename || "", isDir: Boolean(item.dir) }))
      .filter((item) => isQuarkFid(item.fid));
    if (!targets.length) throw new WangpanError("该分享中没有可删除的资源（未能识别有效 fid）", { provider: "quark" });

    const { deleted } = await this.deleteFiles(targets.map((item) => item.fid));
    return { deleted, fids: targets.map((item) => item.fid), names: targets.map((item) => item.name) };
  }

  /** 校验 Cookie 是否可用（尝试列根目录）。 */
  async ping() {
    const list = await this.listDir("0");
    return { ok: true, count: list.length };
  }
}

export { cookieValue };
