import { validateOutboundUrl, validateRedirectUrl, type OutboundUrlOptions } from "../security/outboundUrl";
import { normalizeOutboundHeaders } from "../security/outboundHeaders";
import { byteLength, isExpectedContentType } from "./responseBody";
import type { SafeHttpRequest } from "./types";

/** Pure policy checks; response streams and cancellation belong to the executor. */
export function prepareSafeHttpRequest(request: SafeHttpRequest) {
  for (const name of ["maxRequestBodyBytes", "maxResponseBytes", "maxRedirects"] as const) {
    if (!Number.isSafeInteger(request[name]) || request[name] < 0) {
      throw new Error("无效的安全 HTTP 限制: " + name);
    }
  }
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0 || request.timeoutMs > 2_147_483_647) {
    throw new Error("无效的安全 HTTP 限制: timeoutMs");
  }
  const urlOptions: OutboundUrlOptions = {
    allowedDomains: request.allowedDomains,
    allowHttp: request.allowHttp,
  };
  const url = validateOutboundUrl(request.url, urlOptions);
  const headers = normalizeOutboundHeaders(request.headers);
  if (request.body && byteLength(request.body) > request.maxRequestBodyBytes) {
    throw new Error("请求体超过大小限制 (" + request.maxRequestBodyBytes + " bytes)");
  }
  return { url, headers, urlOptions };
}

export function redirectTarget(
  response: Response,
  from: URL,
  redirects: number,
  request: SafeHttpRequest,
  options: OutboundUrlOptions,
): URL {
  if (!request.followRedirects) throw new Error("禁止自动重定向: " + response.status);
  if (redirects >= request.maxRedirects) throw new Error("重定向次数超过限制");
  const location = response.headers.get("location");
  if (!location) throw new Error("重定向缺少 Location");
  const next = validateRedirectUrl(from, location, options);
  if (next.origin !== from.origin) {
    throw new Error("禁止跨域重定向: " + from.origin + " -> " + next.origin);
  }
  return next;
}

export function validateResponseType(response: Response, expected: readonly string[]): string {
  if (!response.ok) throw new Error("来源 HTTP 错误: " + response.status);
  const contentType = (response.headers.get("content-type")?.split(";", 1)[0] ?? "").trim().toLowerCase();
  if (!isExpectedContentType(contentType, expected)) {
    throw new Error("不允许的响应 Content-Type: " + (contentType || "missing"));
  }
  return contentType;
}
