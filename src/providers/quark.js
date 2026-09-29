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

/** 夸克用到的所有上游域名（用于连接预热——两个域名各自都要一次握手）。 */
export function quarkBases() {
  return [SHARE_BASE(), PC_BASE()];
}

/**
 * 夸克常见错误码 → 更可操作的中文说明。
 *
 * 上游返回的 message 有时过于简略（例如 41017 只给一句"用户禁止转存自己的分享"），
 * 这里补充「该怎么处理」的提示。
 */
const ERROR_TEXT = {
  "41017": "这是你自己的分享，夸克不允许转存自己的分享。可以直接用「检测已有」为它生成一条新分享链接。",
  "41008": "分享已失效或被取消，请确认链接是否还有效。",
  "31001": "登录态已失效，请重新获取 Cookie。",
  "31024": "操作过于频繁，请稍后再试。",
};

function quarkErrorText(code, fallback) {
  return ERROR_TEXT[String(code)] || fallback || `夸克接口错误（code ${code}）`;
}

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
    /** 每个上游请求的耗时记录，用于诊断性能瓶颈。 */
    this.trace = [];
  }

  /** 记录一步耗时，供上层做性能诊断。 */
  #record(step, ms) {
    this.trace.push({ step, ms });
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

  async #request(base, path, { method = "GET", params = {}, body = null, referer = "https://pan.quark.cn/", step = null } = {}) {
    const url = `${base}/${path}?${this.#params(params)}`;
    const startedAt = Date.now();
    let response;
    try {
      response = await httpRequest(url, {
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
    } finally {
      // 放在 finally 里，超时/失败的那一步也能被记录下来
      this.#record(step || path, Date.now() - startedAt);
    }
    const { ok, status, body: raw } = response;
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new WangpanError(`夸克接口 ${path} 返回非 JSON（HTTP ${status}）`, { provider: "quark" });
    }
    const code = Number(payload?.code);
    const success = ok && payload?.status !== "error" && (payload?.code === undefined || code === 0);
    if (!success) {
      const message = quarkErrorText(code, payload?.message || payload?.error);
      throw new WangpanError(message, { code: Number.isFinite(code) ? code : null, provider: "quark" });
    }
    return payload;
  }

  /**
   * 轮询夸克异步任务，直到完成（status=2）或失败（status=3）。
   *
   * 关于间隔——这里有个坑，实测数据如下（一次 save 里 5 次轮询）：
   *
   *   上游 metadata.tq_gap 给的是 **500ms**（第二轮起 1000ms），这是给**长任务**的建议值。
   *   但夸克这类元数据任务通常几十~几百毫秒就执行完了（实测首次轮询还在 status=1，
   *   第二次就已经 status=2）。照 500ms 等，只是让我们**晚 500ms 才发现任务已经完成**——
   *   实测一次 save 有 1.5s 全耗在这种白等上（3041ms 里各步网络耗时只有 1393ms）。
   *
   * 所以策略是：
   *  - 前 fastWindowMs（3 秒）内**不让 tq_gap 拖慢我们**，按 fastIntervalMs（150ms）轮询；
   *  - 超过 3 秒说明确实是长任务，这时才采纳 tq_gap（夹在 [minIntervalMs, slowIntervalMs]）。
   *
   * 另外「间隔」按**轮询周期**算：从请求发出那一刻起计时。若写成「请求返回后再 sleep 一个间隔」，
   * 实际周期会变成 请求耗时 + 间隔（暖连接下也多出 ~80ms/轮）。
   */
  async waitTask(
    taskId,
    { maxWaitMs = 120_000, minIntervalMs = 120, fastIntervalMs = 150, fastWindowMs = 3000, slowIntervalMs = 1000 } = {},
  ) {
    const startedAt = Date.now();
    const deadline = startedAt + maxWaitMs;
    let retryIndex = 0;
    while (Date.now() < deadline) {
      const pollStartedAt = Date.now();
      const result = await this.#request(PC_BASE(), "task", {
        params: { task_id: taskId, retry_index: retryIndex++ },
        step: "等待任务",
      });
      const status = Number(result?.data?.status);
      if (status === 2) return result.data;
      if (status === 3) throw new WangpanError(result?.data?.message || "夸克任务执行失败", { provider: "quark" });

      const inFastWindow = Date.now() - startedAt < fastWindowMs;
      let interval = inFastWindow ? fastIntervalMs : slowIntervalMs;
      const suggested = Number(result?.metadata?.tq_gap);
      if (Number.isFinite(suggested) && suggested > 0 && !inFastWindow) {
        interval = Math.min(Math.max(suggested, minIntervalMs), slowIntervalMs);
      }
      const remaining = interval - (Date.now() - pollStartedAt);
      if (remaining > 0) {
        await delay(remaining);
        // 把等待也记进 trace：否则日志里各步之和会明显小于总耗时，
        // 排查时看不出时间花在哪（这次就是 1.6s 藏在这里）。
        this.#record("轮询等待", remaining);
      }
    }
    throw new WangpanError("夸克任务超时", { provider: "quark" });
  }

  /** 获取分享访问令牌（stoken）。这一步失败通常意味着链接失效或提取码错误。 */
  async shareToken(pwdId, passcode) {
    const response = await this.#request(SHARE_BASE(), "share/sharepage/token", {
      method: "POST",
      body: { pwd_id: pwdId, passcode: passcode || "", support_visit_limit_private_share: true },
      step: "取分享令牌",
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
      step: "读分享详情",
    });
  }

  /**
   * 解析分享，拿到后续所有操作都要用的最小上下文（pwdId / stoken / 根目录清单）。
   *
   * 抽成单独一步是为了**复用**：勾选去重时，先解析一遍分享判断是否已存在，
   * 未命中再转存。若转存时重新解析，就会白跑「取分享令牌 + 读分享详情」两个来回。
   */
  async #resolveShare(url, password = null) {
    const { pwdId, passcode } = parseQuarkShareUrl(url, password);
    const stoken = await this.shareToken(pwdId, passcode);
    const detail = await this.shareDetail(pwdId, stoken);
    const list = Array.isArray(detail?.data?.list) ? detail.data.list : [];
    return {
      pwdId,
      stoken,
      list,
      title: detail?.data?.share?.title || "",
      fileNum: Number(detail?.data?.share?.file_num ?? list.length),
    };
  }

  /**
   * 能力 1：校验分享链接是否有效，并返回根目录文件清单。
   * @returns {Promise<{valid:boolean, reason?:string, title:string, fileCount:number, files:Array, context:object}>}
   *          context 为可直接传给 saveShare 的复用上下文（不对外暴露，见 index.js）
   */
  async validateShare(url, password = null) {
    try {
      const context = await this.#resolveShare(url, password);
      const { pwdId, stoken, list } = context;
      return {
        valid: true,
        title: context.title,
        fileCount: context.fileNum,
        files: list.map((item) => ({
          fid: String(item.fid || ""),
          name: item.file_name || item.filename || "",
          size: Number(item.size || 0),
          isDir: Boolean(item.dir),
          shareFidToken: item.share_fid_token || "",
        })),
        stoken,
        pwdId,
        context,
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
   * @param {object|null} [options.shareContext] 已解析好的分享上下文（来自 validateShare），
   *        传入可省掉「取分享令牌 + 读分享详情」两个网络来回
   * @returns {Promise<{saved:boolean, taskId:string|null, toPdirFid:string, files:number, names:string[], share:object|null}>}
   */
  async saveShare(url, password = null, { toPdirFid = "0", autoShare = false, shareContext = null } = {}) {
    this.requireLogin();
    const { pwdId, stoken, list } = shareContext || (await this.#resolveShare(url, password));
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
      step: "转存",
    });
    const taskId = response?.data?.task_id ? String(response.data.task_id) : null;
    // 夸克对这类元数据任务常常**同步执行完**（响应里带 task_sync: true 与完整的 task_resp）。
    // 已经完成就不用再轮询，能省掉 1~4 个来回（每轮 ~380ms）。没有 task_resp 时照旧轮询。
    const inlineStatus = Number(response?.data?.task_resp?.data?.status);
    if (inlineStatus !== 2 && taskId) await this.waitTask(taskId);

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
      step: "列目录",
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
   * 纯比对逻辑：把分享条目与"我网盘目录"条目按 名称 + 大小 匹配（无网络请求）。
   * 拆出来是为了让调用方能把 listDir 与解析分享并行执行。
   */
  matchExisting(files, mine) {
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

  /**
   * 能力 3：判断分享中的文件是否已存在于自己网盘（按 名称 + 大小 匹配）。
   * @returns {Promise<{exists:boolean, matched:Array, missing:Array}>}
   */
  async findExisting(files, pdirFid = "0") {
    return this.matchExisting(files, await this.listDir(pdirFid));
  }

  /** 对自己网盘中的文件创建分享链接。 */
  async createShare(fids, { title = "PanHub 分享", expiredType = 1 } = {}) {
    this.requireLogin();
    const created = await this.#request(PC_BASE(), "share", {
      method: "POST",
      body: { fid_list: fids, title, url_type: 1, expired_type: expiredType, expire_time: 0 },
      step: "创建分享",
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
      step: "取分享链接",
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
      step: "删除",
    });
    const taskId = response?.data?.task_id;
    // 同转存：响应里任务已完成就不用再轮询
    const inlineStatus = Number(response?.data?.task_resp?.data?.status);
    if (inlineStatus !== 2 && taskId) await this.waitTask(String(taskId));
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
