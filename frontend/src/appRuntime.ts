import { ref, type Ref } from "vue";
import { useRouter } from "vue-router";
const state = new Map<string, Ref<unknown>>();
export function useSharedState<T>(key: string, init: () => T): Ref<T> {
  if (!state.has(key)) state.set(key, ref(init()) as Ref<unknown>);
  return state.get(key) as Ref<T>;
}

export const appConfig = {
  apiBase: "/api",
  siteName: "盘搜",
  homeTitle: "网盘资源聚合搜索",
  homeDescription: "网盘、磁力、公开频道，一个搜索框直达。",
  siteTitle: "网盘资源聚合搜索｜盘搜 pansou",
  siteDescription: "盘搜聚合网盘分享、磁力链接与公开频道资源。",
  siteKeywords: "盘搜, pansou, 网盘搜索",
  siteImageAlt: "盘搜 pansou 网盘资源聚合搜索",
};
export async function navigate(to: string | { path: string; query?: Record<string, unknown> }, options?: { replace?: boolean }) {
  const router = useRouter();
  return options?.replace ? router.replace(to as any) : router.push(to as any);
}


export type ApiClientError = Error & {
  status?: number;
  statusCode?: number;
  data?: any;
  code?: string;
};

export function httpErrorMessage(status: number, action = "请求"): string {
  if (status === 401) return `${action}未通过身份或会话校验，请刷新页面后重试。`;
  if (status === 403) return `${action}被拒绝，当前账号没有对应权限。`;
  if (status === 429) return `${action}过于频繁，请稍后再试。`;
  if (status === 502 || status === 503 || status === 504) return `服务暂时不可用（${status}），请稍后重试。`;
  if (status >= 500) return `服务端处理失败（${status}），请稍后重试；本地开发请确认 Rust 服务已启动。`;
  return `${action}失败（${status}），请稍后重试。`;
}

function errorFromResponse(response: Response, body: any): ApiClientError {
  const error = new Error(body?.statusMessage || body?.message || httpErrorMessage(response.status)) as ApiClientError;
  error.status = response.status;
  error.statusCode = response.status;
  error.data = body;
  error.code = typeof body?.code === "string" ? body.code : undefined;
  return error;
}

export function apiErrorMessage(error: any, fallback = "请求失败，请稍后重试。"): string {
  if (error?.name === "AbortError") return "请求已取消。";
  const message = error?.data?.statusMessage || error?.data?.message || error?.statusMessage || error?.message;
  if (message && message !== "Failed to fetch") return String(message);
  return fallback;
}

export function reportApiError(error: any, context: { url?: string; method?: string } = {}) {
  if (typeof window === "undefined" || error?.name === "AbortError") return;
  window.dispatchEvent(new CustomEvent("pansou:api-error", {
    detail: {
      message: apiErrorMessage(error, "无法连接服务端，请检查服务是否正常运行。"),
      status: error?.statusCode || error?.status,
      code: error?.data?.code || error?.code,
      url: context.url,
      method: context.method,
    },
  }));
}

export type ApiFetchOptions = Omit<RequestInit, "body"> & {
  query?: Record<string, unknown>;
  body?: unknown;
  cache?: RequestCache;
  silentError?: boolean;
};
export async function apiFetch<T = unknown>(url: string, options: ApiFetchOptions = {}): Promise<T> {
  const query = options.query
    ? `?${new URLSearchParams(
      Object.entries(options.query).flatMap(([key, value]) => {
        if (value === undefined || value === null) return [];
        return Array.isArray(value)
          ? value.filter((item) => item !== undefined && item !== null).map((item) => [key, String(item)])
          : [[key, String(value)]];
      }),
    ).toString()}`
    : "";
  const headers = new Headers(options.headers || {});
  const rawBody = options.body;
  let body: BodyInit | undefined;
  if (rawBody !== undefined && typeof rawBody !== "string" && !(rawBody instanceof FormData) && !(rawBody instanceof Blob)) {
    headers.set("content-type", "application/json"); body = JSON.stringify(rawBody);
  } else {
    body = rawBody as BodyInit | undefined;
  }
  const { query: _query, body: _body, silentError, ...requestOptions } = options;
  const requestUrl = `${url}${query}`;
  let response: Response;
  try {
    response = await fetch(requestUrl, {
      ...requestOptions,
      body,
      headers,
      credentials: options.credentials || "include",
    });
  } catch (reason: any) {
    const error = reason?.name === "AbortError"
      ? reason
      : Object.assign(new Error("无法连接服务端，请检查网络或确认 Rust 服务已经启动。"), {
          status: 0,
          statusCode: 0,
          data: { code: "NETWORK_ERROR" },
        });
    if (!silentError) reportApiError(error, { url: requestUrl, method: options.method || "GET" });
    throw error;
  }
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json().catch(() => undefined) : await response.text();
  if (!response.ok) {
    const error = errorFromResponse(response, payload);
    if (!silentError) reportApiError(error, { url: requestUrl, method: options.method || "GET" });
    throw error;
  }
  return payload as T;
}

function setMeta(name: string, content: string | undefined, property = false) {
  if (!content) return;
  let el = document.head.querySelector(`meta[${property ? "property" : "name"}="${name}"]`) as HTMLMetaElement | null;
  if (!el) { el = document.createElement("meta"); el.setAttribute(property ? "property" : "name", name); document.head.appendChild(el); }
  el.content = content;
}
export function setDocumentHead(input: any) {
  const value = typeof input === "function" ? input() : input;
  if (value?.title) document.title = value.title;
  for (const meta of value?.meta || []) setMeta(meta.name || meta.property, meta.content, !!meta.property);
  for (const link of value?.link || []) { let el = document.head.querySelector(`link[rel="${link.rel}"]`) as HTMLLinkElement | null; if (!el) { el = document.createElement("link"); document.head.appendChild(el); } Object.assign(el, link); }
}

