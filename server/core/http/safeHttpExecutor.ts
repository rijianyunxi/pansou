import {
  validateOutboundUrl,
  validateRedirectUrl,
  type OutboundUrlOptions,
} from "../security/outboundUrl";
import { resolveSafeHostAddresses } from "../security/dnsGuard";
import { loadPinnedHttpTransport } from "../utils/fetch";
import { logUpstreamRequest } from "../utils/upstreamDebug";

export const FORBIDDEN_OUTBOUND_HEADERS = new Set([
  "cookie",
  "authorization",
  "proxy-authorization",
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "forwarded",
  "via",
]);

export function isForbiddenOutboundHeader(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    FORBIDDEN_OUTBOUND_HEADERS.has(normalized) ||
    normalized.startsWith("proxy-") ||
    normalized.startsWith("x-forwarded-")
  );
}

export interface SafeHttpRequest {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  maxRequestBodyBytes: number;
  maxResponseBytes: number;
  maxRedirects: number;
  followRedirects: boolean;
  expectedContentTypes: readonly string[];
  allowedDomains?: readonly string[];
  allowHttp?: boolean;
}

export interface SafeHttpResponse {
  response: Response;
  url: URL;
  body: string;
  bytes: number;
  contentType: string;
  redirects: number;
  elapsedMs: number;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    const reason = signal.reason;
    throw reason instanceof Error ? reason : new Error("操作已取消");
  }
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        const reason = signal.reason;
        reject(reason instanceof Error ? reason : new Error("操作已取消"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      promise.finally(() => signal.removeEventListener("abort", onAbort)).catch(() => undefined);
    }),
  ]);
}

async function readResponseBody(
  response: Response,
  maxBytes: number
): Promise<{ body: string; bytes: number }> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) {
    throw new Error(`响应超过大小限制 (${maxBytes} bytes)`);
  }
  if (!response.body) {
    const body = await response.text();
    const bytes = byteLength(body);
    if (bytes > maxBytes) {
      throw new Error(`响应超过大小限制 (${maxBytes} bytes)`);
    }
    return { body, bytes };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error(`响应超过大小限制 (${maxBytes} bytes)`);
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: new TextDecoder().decode(merged), bytes };
}

function normalizeHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (isForbiddenOutboundHeader(name)) {
      throw new Error(`禁止设置请求头: ${name}`);
    }
    normalized[name] = String(value);
  }
  return normalized;
}

function isExpectedContentType(
  contentType: string,
  expected: readonly string[]
): boolean {
  return expected.some((allowed) => {
    const normalized = allowed.toLowerCase();
    if (normalized === "application/*+json") {
      return contentType.startsWith("application/") && contentType.endsWith("+json");
    }
    return contentType === normalized;
  });
}

/**
 * Single security boundary for dynamic outbound HTTP requests.
 * It validates every redirect, enforces total timeout/body limits, and never
 * lets callers opt into native redirect following.
 */
export async function executeSafeHttp(
  request: SafeHttpRequest
): Promise<SafeHttpResponse> {
  const urlOptions: OutboundUrlOptions = {
    allowedDomains: request.allowedDomains,
    allowHttp: request.allowHttp,
  };
  let requestUrl = validateOutboundUrl(request.url, urlOptions);
  const headers = normalizeHeaders(request.headers);

  if (request.body && byteLength(request.body) > request.maxRequestBodyBytes) {
    throw new Error(`请求体超过大小限制 (${request.maxRequestBodyBytes} bytes)`);
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort(request.signal?.reason);
  if (request.signal?.aborted) controller.abort(request.signal.reason);
  else request.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => {
    const error = new Error(`安全 HTTP 请求超时 (${request.timeoutMs}ms)`);
    error.name = "TimeoutError";
    controller.abort(error);
  }, request.timeoutMs);
  const started = Date.now();
  logUpstreamRequest("start", { method: request.method, url: requestUrl.toString(), body: request.body });

  try {
    // Node 专属：能把 socket 钉在已校验 IP 上的传输。Cloudflare Workers
    // （无自定义 DNS/socket 能力）或解析器不可用时为 null，降级为原生 fetch。
    const transport = await awaitWithAbort(loadPinnedHttpTransport(), controller.signal);
    let response: Response;
    let redirects = 0;
    for (;;) {
      // Re-check DNS on every hop so a rebinding host cannot rotate to a
      // private address after the initial URL validation. On Node the
      // validated addresses also pin the actual connection, closing the
      // TOCTOU gap where fetch would re-resolve the hostname and connect to
      // an attacker-controlled IP. On runtimes without socket control
      // (Cloudflare Workers) or when DNS verification is unavailable
      // (fail-open policy) this returns null and we degrade to native fetch
      // with static per-hop validation only.
      const pinned = await resolveSafeHostAddresses(requestUrl.hostname, controller.signal);
      response = transport && pinned
        ? await transport.request(
            requestUrl,
            {
              method: request.method,
              headers,
              body: request.body,
              signal: controller.signal,
            },
            pinned
          )
        : await fetch(requestUrl, {
            method: request.method,
            headers,
            body: request.body,
            signal: controller.signal,
            redirect: "manual",
          });
      if (response.status < 300 || response.status >= 400) break;
      if (!request.followRedirects) {
        throw new Error(`禁止自动重定向: ${response.status}`);
      }
      if (redirects >= request.maxRedirects) {
        throw new Error("重定向次数超过限制");
      }
      const location = response.headers.get("location");
      if (!location) throw new Error("重定向缺少 Location");
      await response.body?.cancel();
      requestUrl = validateRedirectUrl(requestUrl, location, urlOptions);
      redirects++;
    }

    if (!response) throw new Error("未收到来源响应");
    const finalResponse = response as Response;
    if (!finalResponse.ok) {
      // 释放 socket（钉住传输为独立连接），避免悬空连接。
      await finalResponse.body?.cancel();
      throw new Error(`来源 HTTP 错误: ${finalResponse.status}`);
    }
    const rawContentType = finalResponse.headers.get("content-type") ?? "";
    const contentType = (rawContentType.split(";", 1)[0] ?? "")
      .trim()
      .toLowerCase();
    if (!isExpectedContentType(contentType, request.expectedContentTypes)) {
      await finalResponse.body?.cancel();
      throw new Error(`不允许的响应 Content-Type: ${contentType || "missing"}`);
    }
    const payload = await readResponseBody(response, request.maxResponseBytes);
    logUpstreamRequest("success", {
      method: request.method,
      url: requestUrl.toString(),
      status: finalResponse.status,
      elapsedMs: Date.now() - started,
      bytes: payload.bytes,
      contentType,
      responsePreview: payload.body,
    });
    return {
      response: finalResponse,
      url: requestUrl,
      body: payload.body,
      bytes: payload.bytes,
      contentType,
      redirects,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    logUpstreamRequest("error", {
      method: request.method,
      url: requestUrl.toString(),
      elapsedMs: Date.now() - started,
      error,
    });
    throw error;
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener("abort", onAbort);
  }
}
