/**
 * Node 运行时的 DNS 钉住出站传输。
 *
 * 搜索来源的请求由 source-runtime 负责单次执行；本文件只保留 HTTP 安全
 * 传输所需的底层类型和实现，不再提供重试或批量执行封装。
 */

import type { DnsLookupRecord } from "../security/dnsGuard";
import type { IncomingMessage } from "node:http";
import type { Readable as NodeReadable } from "node:stream";

/*
 * ============================================================================
 * DNS 钉住（pinned）出站传输（仅 Node 运行时）
 * ============================================================================
 * 背景（todo.md 6.6 #1）：dnsGuard 校验通过后，原生 fetch 会再次解析域名，
 * 实际连接可能指向被 rebinding 后的恶意 IP。此传输用 node:http/node:https 的
 * `lookup` 选项把 socket 钉在已校验的 IP 上，同时保持 `host`/`servername` 为
 * 原始主机名，因此 Host 头、SNI 与 TLS 证书校验仍然匹配真实域名，证书校验
 * （rejectUnauthorized）保持安全默认值不被削弱。
 *
 * Cloudflare Workers 能力差异与降级路径：
 * - Workers（即使开启 nodejs_compat）无法控制 DNS 解析与底层 socket 连接，
 *   `loadPinnedHttpTransport()` 返回 null；
 * - 调用方（safeHttpExecutor）随即降级为原生 fetch + 逐跳静态校验
 *   （outboundUrl 的 IP/域名黑名单 + dnsGuard 的可用时解析校验），
 *   与钉住方案落地前的行为一致。
 * - 所有 node:* 依赖均为运行时探测 + 动态 import，模块顶层不引入任何
 *   Node 专属运行时依赖，Workers 构建不受影响。
 */

export interface PinnedRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface PinnedHttpTransport {
  /**
   * 发起一个 socket 直接连到已校验地址（而非再次解析 url.hostname）的请求。
   * 返回 Web Response，响应体为流，交由调用方做大小限制与类型检查。
   */
  request(
    url: URL,
    init: PinnedRequestInit,
    pinned: readonly DnsLookupRecord[]
  ): Promise<Response>;
}

/** node:http / node:https 所需的最小结构化接口（便于测试注入替身）。 */
export interface NodeClientRequestLike {
  end(body?: string): unknown;
  destroy(error?: Error): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface NodePinnedHttpModule {
  request(
    options: Record<string, unknown>,
    callback?: (response: IncomingMessage) => void
  ): NodeClientRequestLike;
}

export interface NodePinnedTransportModules {
  http: NodePinnedHttpModule;
  https: NodePinnedHttpModule;
  stream: {
    Readable: {
      toWeb(readable: NodeReadable): ReadableStream<Uint8Array>;
    };
  };
}

function abortError(): Error {
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

function bareHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

/**
 * 自定义 lookup：无论系统 DNS 返回什么，一律把连接指向已校验地址。
 * 兼容 `all: true`（Happy Eyeballs）与单地址两种回调形态。
 */
function pinnedLookup(record: DnsLookupRecord): unknown {
  return (
    _hostname: string,
    options: { all?: boolean },
    callback: (
      err: Error | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number
    ) => void
  ): void => {
    if (options?.all) {
      callback(null, [{ address: record.address, family: record.family }]);
    } else {
      callback(null, record.address, record.family);
    }
  };
}

function toWebRequestHeaders(raw: IncomingMessage["headers"]): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
  }
  return headers;
}

function nodePinnedRequest(
  modules: NodePinnedTransportModules,
  url: URL,
  init: PinnedRequestInit,
  pinned: readonly DnsLookupRecord[]
): Promise<Response> {
  const record = pinned[0];
  if (!record) {
    return Promise.reject(new Error("缺少可钉住的已校验解析地址"));
  }
  const isHttps = url.protocol === "https:";
  const mod = isHttps ? modules.https : modules.http;
  const port = url.port ? Number(url.port) : isHttps ? 443 : 80;
  const headers: Record<string, string> = { ...init.headers };
  const hasHeader = (name: string): boolean =>
    Object.keys(headers).some((key) => key.toLowerCase() === name);
  if (init.body != null && !hasHeader("content-length")) {
    // 与 fetch 行为对齐：显式声明长度，避免分块传输编码。
    headers["content-length"] = String(
      new TextEncoder().encode(init.body).byteLength
    );
  }
  if (init.body != null && !hasHeader("content-type")) {
    // 与 fetch 规范对齐：字符串 body 的默认 Content-Type。
    headers["content-type"] = "text/plain;charset=UTF-8";
  }
  const requestInit: Record<string, unknown> = {
    // host 保持原始主机名：Host 头、SNI（servername）与 TLS 证书校验都继续
    // 匹配真实域名；pinned lookup 仅把 TCP 连接改道到已校验地址。
    host: url.hostname,
    servername: bareHostname(url),
    port,
    family: record.family,
    method: init.method,
    path: `${url.pathname}${url.search}`,
    headers,
    // 每次请求独立 socket：确保每跳真正连到该跳钉住的 IP，杜绝 keep-alive
    // 连接池把请求复用到旧地址带来的语义模糊。代价是无连接复用。
    agent: false,
    lookup: pinnedLookup(record),
  };

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let currentResponse: IncomingMessage | null = null;
    let req: NodeClientRequestLike;
    try {
      req = mod.request(requestInit, (res) => {
        try {
          currentResponse = res;
          const body = modules.stream.Readable.toWeb(
            res as NodeReadable
          ) as ReadableStream<Uint8Array>;
          const response = new Response(body, {
            status: res.statusCode ?? 502,
            statusText: res.statusMessage ?? "",
            headers: toWebRequestHeaders(res.headers),
          });
          settled = true;
          resolve(response);
        } catch (error) {
          settled = true;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    // 手动接线取消：req.destroy(reason) 保证请求以调用方的原始 reason 失败
    // （与原生 fetch 拒绝语义一致），而不是 node:http 默认的通用 AbortError。
    const signal = init.signal;
    const onAbort = (): void => {
      const reason = signal?.reason;
      const error = reason instanceof Error ? reason : abortError();
      // 先销毁响应流（若头部已到达），保证 body 读取以同一 reason 失败。
      (currentResponse as NodeReadable | null)?.destroy(error);
      req.destroy(error);
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
        req.on("close", () => signal.removeEventListener("abort", onAbort));
      }
    }
    req.on("error", (error: Error) => {
      if (!settled) reject(error);
    });

    try {
      if (init.body != null) {
        req.end(init.body);
      } else {
        req.end();
      }
    } catch (error) {
      req.destroy(error instanceof Error ? error : abortError());
      if (!settled) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
}

/**
 * 创建 Node 钉住传输。模块显式注入以便测试替换 https 模块；生产代码请使用
 * `loadPinnedHttpTransport()`（含运行时能力探测与缓存）。
 */
export function createNodePinnedHttpTransport(
  modules: NodePinnedTransportModules
): PinnedHttpTransport | null {
  if (
    typeof modules.http?.request !== "function" ||
    typeof modules.https?.request !== "function" ||
    typeof modules.stream?.Readable?.toWeb !== "function"
  ) {
    return null;
  }
  return {
    request: (url, init, pinned) =>
      nodePinnedRequest(modules, url, init, pinned),
  };
}

let cachedNodeTransport: PinnedHttpTransport | null | undefined;

export async function loadPinnedHttpTransport(): Promise<PinnedHttpTransport | null> {
  if (cachedNodeTransport !== undefined) return cachedNodeTransport;
  cachedNodeTransport = null;
  try {
    const globalScope = globalThis as {
      process?: { versions?: { node?: unknown } };
      navigator?: { userAgent?: string };
    };
    // Cloudflare Workers 的固定标识：无自定义 DNS/socket 能力，直接降级。
    if (globalScope.navigator?.userAgent === "Cloudflare-Workers") {
      return cachedNodeTransport;
    }
    // 真实 Node 运行时探测（Workers 的 nodejs_compat 可能模拟 process）。
    if (typeof globalScope.process?.versions?.node !== "string") {
      return cachedNodeTransport;
    }
    const [http, https, stream] = await Promise.all([
      import("node:http"),
      import("node:https"),
      import("node:stream"),
    ]);
    cachedNodeTransport = createNodePinnedHttpTransport({
      http,
      https,
      stream: stream as unknown as NodePinnedTransportModules["stream"],
    });
  } catch {
    // 无 node:http/https/stream 的运行时：钉住传输不可用，调用方降级。
    cachedNodeTransport = null;
  }
  return cachedNodeTransport;
}
