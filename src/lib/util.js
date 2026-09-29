/**
 * 通用工具：Cookie 解析/合并、延时、格式化、错误类型、HTTP 请求。
 */

import http from "node:http";
import https from "node:https";

/** 业务错误：表示"输入/上游返回"层面的可预期失败（链接失效、提取码错误等）。 */
export class WangpanError extends Error {
  constructor(message, { code = null, provider = null, cause = null } = {}) {
    super(message);
    this.name = "WangpanError";
    this.code = code;
    this.provider = provider;
    if (cause) this.cause = cause;
  }
}

/** 从 Cookie 字符串中取某个键的值，取不到返回空串。 */
export function cookieValue(cookie, name) {
  if (!cookie) return "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`, "u"));
  return match?.[1] ?? "";
}

/**
 * 把响应里的 Set-Cookie 合并进当前 Cookie（百度会刷新 STOKEN 等）。
 * @param {string} cookie 当前 Cookie
 * @param {Response|Headers} source Response 或 Headers，二者皆可
 */
export function mergeSetCookies(cookie, source) {
  const values = new Map();
  for (const part of String(cookie || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0) values.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  const headers = source?.headers ?? source;
  if (!headers?.get) return [...values.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  const setCookies =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : (headers.get("set-cookie") || "").split(/,(?=[A-Za-z0-9_]+=)/u).filter(Boolean);
  for (const value of setCookies) {
    const separator = value.indexOf("=");
    if (separator > 0) values.set(value.slice(0, separator).trim(), value.slice(separator + 1).split(";", 1)[0].trim());
  }
  return [...values.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${index === 0 ? value : value.toFixed(2)} ${units[index]}`;
}

export function timeoutMs() {
  const raw = Number(process.env.WANGPAN_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

/**
 * 连接池：Node 原生 fetch 走的是 undici，其 keep-alive 只有 4 秒，
 * 空闲超过 4 秒连接即被丢弃，下一次请求要重新 TCP+TLS 握手（实测 222~360ms，
 * 而热连接只要 51~75ms）。这里自建 http/https Agent 把空闲连接保活到 60 秒，
 * 让同一批请求（一次转存有 5~7 个上游请求）几乎全部命中已建好的连接。
 *
 * 注意 keepAliveMsecs 是 TCP 层 SO_KEEPALIVE 的探测间隔，不是空闲回收时间；
 * 空闲 socket 的复用时长由 Agent 的 freeSockets 保留策略决定（默认不主动回收，
 * 直到对端关闭），这正是我们要的效果。
 */
const AGENT_OPTIONS = {
  keepAlive: true,
  keepAliveMsecs: 60_000,
  maxSockets: 16,
  maxFreeSockets: 8,
  scheduling: "lifo",
};
const AGENTS = {
  "http:": new http.Agent(AGENT_OPTIONS),
  "https:": new https.Agent(AGENT_OPTIONS),
};

/** 与 fetch 的 Headers 保持最小兼容：只需要 get / getSetCookie / has。 */
class HeaderBag {
  constructor(raw = {}) {
    this.raw = raw;
  }

  get(name) {
    const value = this.raw[String(name).toLowerCase()];
    if (value === undefined) return null;
    return Array.isArray(value) ? value.join(", ") : String(value);
  }

  getSetCookie() {
    const value = this.raw["set-cookie"];
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }

  has(name) {
    return this.raw[String(name).toLowerCase()] !== undefined;
  }
}

/** 用自建连接池发一次请求，读完整响应体后返回（不含计时，计时在 httpRequest 里做）。 */
function pooledRequest(url, { method = "GET", headers = {}, body, signal } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new WangpanError(`URL 不合法：${url}`));
      return;
    }
    const agent = AGENTS[target.protocol];
    if (!agent) {
      reject(new WangpanError(`不支持的协议：${target.protocol}`));
      return;
    }

    const transport = target.protocol === "https:" ? https : http;
    const chunks = [];
    let settled = false;
    let request;
    let onAbort = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      fn(value);
    };

    const attempt = (isRetry) => {
      request = transport.request(target, { method, headers, agent }, (response) => {
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", (error) => finish(reject, error));
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          finish(resolve, {
            ok: status >= 200 && status < 300,
            status,
            headers: new HeaderBag(response.headers),
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      });

      request.on("error", (error) => {
        // 保活连接可能在对端已经关闭后才被复用，此时会拿到 ECONNRESET / EPIPE。
        // 只有在「复用了旧连接」且「响应一个字节都没收到」时才重试一次——
        // 这种情况下服务端是在我们发请求前就发了 FIN，重试不会造成重复执行。
        const stale =
          request.reusedSocket &&
          chunks.length === 0 &&
          (error.code === "ECONNRESET" || error.code === "EPIPE");
        if (stale && !isRetry) {
          attempt(true);
          return;
        }
        finish(reject, error);
      });

      if (body !== undefined && body !== null) request.end(body);
      else request.end();
    };

    onAbort = () => {
      const error = new WangpanError(`请求已取消：${target.host}`);
      request?.destroy(error);
      finish(reject, error);
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    attempt(false);
  });
}

/**
 * 在**同一个超时窗口**内完成「发请求 + 读响应体」，并返回统一的响应描述。
 *
 * 为什么不能只给请求挂一个信号：只覆盖到拿到响应头是不够的，若上游返回响应头后
 * body 迟迟不结束（黑洞/代理缓冲），读体阶段会无限挂起。所以这里的超时定时器
 * 一直挂到「响应体读完」，超时就直接 destroy 掉底层 socket。
 *
 * @returns {Promise<{ok:boolean, status:number, headers:HeaderBag, body:string, ms:number}>}
 */
export async function httpRequest(url, options = {}) {
  const ms = timeoutMs();
  const controller = new AbortController();
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* 保持原样 */
  }
  const timer = setTimeout(() => controller.abort(), ms);
  const startedAt = Date.now();
  try {
    const result = await pooledRequest(url, { ...options, signal: controller.signal });
    return { ...result, ms: Date.now() - startedAt };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new WangpanError(`请求超时（${ms}ms），上游无响应：${host}`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 主动释放连接池（测试/退出时使用）。 */
export function closeAgents() {
  for (const agent of Object.values(AGENTS)) agent.destroy();
}

/**
 * 预热连接：提前和上游建立 TCP+TLS 连接并放进连接池。
 *
 * 为什么要单独做这件事：一次夸克转存会跨 **两个域名**（分享接口在 drive.quark.cn、
 * 网盘接口在 drive-pc.quark.cn），每个域名的首次请求都要付一次握手（实测 220~360ms）。
 * 页面加载时先把连接握好，用户真正点操作时就是热连接（~80ms）。
 *
 * 两个坑，都是实测出来的：
 *  1. **必须用 GET，不能用 HEAD**。Node 的 http.Agent 不会把 HEAD 请求的 socket
 *     放回 freeSockets，下一条请求仍会重新握手。
 *  2. **要打真实的 API 路径，不能只打域名根**。打 `GET https://drive.quark.cn/` 时
 *     socket 有时留不下来（首步 141ms / 83ms 来回跳）；打 API 路径则稳定在 80ms。
 *
 * 响应内容不重要（大概率是个错误响应），只要握手完成、socket 进池就达到目的；
 * 失败也完全不影响主流程。
 */
export async function warmConnections(urls) {
  const byOrigin = new Map();
  for (const url of urls.filter(Boolean)) {
    try {
      const parsed = new URL(url);
      if (!byOrigin.has(parsed.origin)) byOrigin.set(parsed.origin, parsed.toString());
    } catch {
      /* 忽略非法地址 */
    }
  }
  await Promise.all(
    [...byOrigin.values()].map(async (url) => {
      try {
        await pooledRequest(url, { method: "GET", headers: { "user-agent": "PanHub-Warmup/1.0" } });
      } catch {
        /* 预热失败无所谓 */
      }
    }),
  );
  return [...byOrigin.keys()];
}
