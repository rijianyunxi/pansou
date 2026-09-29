/**
 * 通用工具：Cookie 解析/合并、延时、格式化、错误类型。
 */

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
 * 在**同一个超时窗口**内完成「发请求 + 读响应体」，并返回统一的响应描述。
 *
 * 为什么不能只给 fetch 挂 AbortSignal：AbortSignal 只覆盖到拿到响应头，
 * 若上游返回响应头后 body 迟迟不结束（黑洞/代理缓冲），后续 response.text()
 * 会无限挂起。因此这里用 Promise.race 把「读体」也纳入超时范围。
 *
 * @returns {Promise<{ok:boolean, status:number, headers:Headers, body:string}>}
 */
export async function httpRequest(url, options = {}) {
  const ms = timeoutMs();
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), ms);
  let guardTimer;
  const guard = new Promise((_, reject) => {
    guardTimer = setTimeout(() => {
      let host = url;
      try { host = new URL(url).host; } catch { /* 保持原样 */ }
      reject(new WangpanError(`请求超时（${ms}ms），上游无响应：${host}`));
    }, ms + 500);
  });
  guard.catch(() => {}); // race 先结束后，guard 的拒绝不应变成未处理拒绝

  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(url, { ...options, signal: controller.signal });
        const body = await response.text();
        return { ok: response.ok, status: response.status, headers: response.headers, body };
      })(),
      guard,
    ]);
  } finally {
    clearTimeout(abortTimer);
    clearTimeout(guardTimer);
  }
}
