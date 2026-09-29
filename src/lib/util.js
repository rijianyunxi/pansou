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

/** 把响应里的 Set-Cookie 合并进当前 Cookie（百度会刷新 STOKEN 等）。 */
export function mergeSetCookies(cookie, response) {
  const values = new Map();
  for (const part of String(cookie || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0) values.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  const headers = response.headers;
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
