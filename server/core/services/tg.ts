import { load } from "cheerio";
import { ofetch } from "ofetch";
import type { SearchResult } from "../types/models";
import { matchesSearchKeyword } from "../utils/searchKeyword";

export interface TgFetchOptions {
  limitPerChannel?: number;
  userAgent?: string;
}

export type TgProbeState = "available" | "warning" | "error";

export interface TgProbeRequestSnapshot {
  method: "GET";
  url: string;
  headers: Record<string, string>;
}

export interface TgProbeResponseSnapshot {
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyLength: number;
  bodyTruncated: boolean;
}

export interface TgProbeAttempt {
  route: "telegram" | "jina";
  request: TgProbeRequestSnapshot;
  response: TgProbeResponseSnapshot | null;
  elapsedMs: number;
  error?: string;
}

export interface TgProbeResult {
  channel: string;
  keyword: string;
  state: TgProbeState;
  message: string;
  elapsedMs: number;
  checkedAt: string;
  route: "telegram" | "jina" | "none";
  httpStatus: number | null;
  results: SearchResult[];
  attempts: TgProbeAttempt[];
  upstreamRequest: TgProbeRequestSnapshot | null;
  upstreamResponse: TgProbeResponseSnapshot | null;
}

export async function fetchTgChannelPosts(
  channel: string,
  keyword: string,
  options: TgFetchOptions = {},
): Promise<SearchResult[]> {
  const ua =
    options.userAgent ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

  const limit = options.limitPerChannel ?? 50;
  const maxPages = Math.ceil(limit / 20);
  const allResults: SearchResult[] = [];
  let before: string | undefined;

  for (let page = 0; page < maxPages && allResults.length < limit; page++) {
    const baseUrl = `https://t.me/s/${encodeURIComponent(channel)}`;
    const url = before ? `${baseUrl}?before=${before}` : baseUrl;

    let html = "";
    try {
      html = await ofetch<string>(url, { headers: { "user-agent": ua } });
    } catch {}

    if (!html || !html.includes("tgme_widget_message")) {
      const mirrorUrl = before
        ? `https://r.jina.ai/https://t.me/s/${encodeURIComponent(channel)}?before=${before}`
        : `https://r.jina.ai/https://t.me/s/${encodeURIComponent(channel)}`;

      try {
        html = await ofetch<string>(mirrorUrl, {
          headers: { "user-agent": ua },
        });
      } catch {}
    }

    if (!html || !html.includes("tgme_widget_message")) {
      break;
    }

    const $ = load(html || "");
    const pageResults = parseChannelPage(
      $,
      channel,
      keyword,
      limit - allResults.length,
    );
    allResults.push(...pageResults);

    const nextLink = $('a[href*="before="]').first();
    const href = nextLink.attr("href");
    if (href) {
      const match = href.match(/before=([^&]+)/);
      if (match) {
        before = match[1];
      } else {
        break;
      }
    } else {
      break;
    }

    if (page < maxPages - 1 && allResults.length < limit) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return allResults;
}

export function parseChannelPage(
  $: cheerio.CheerioAPI,
  channel: string,
  keyword: string,
  limit: number,
): SearchResult[] {
  const results: SearchResult[] = [];

  const deproxyUrl = (raw: string): string => {
    try {
      const u = new URL(raw);
      if (u.hostname === "r.jina.ai") {
        const path = decodeURIComponent(u.pathname || "");
        if (path.startsWith("/http://") || path.startsWith("/https://")) {
          return path.slice(1);
        }
      }
      return raw;
    } catch {
      return raw;
    }
  };

  const classifyByHostname = (hostname: string): string => {
    const host = hostname.toLowerCase();
    if (host === "t.me" || host.endsWith(".t.me")) return "";
    if (host === "r.jina.ai") return "";
    if (host.endsWith("alipan.com") || host.endsWith("aliyundrive.com"))
      return "aliyun";
    if (host === "pan.baidu.com") return "baidu";
    if (host === "pan.quark.cn") return "quark";
    if (host === "pan.xunlei.com") return "xunlei";
    if (host.endsWith("123pan.com")) return "123";
    if (host === "cloud.189.cn") return "tianyi";
    if (host === "115.com" || host.endsWith(".115.com")) return "115";
    if (host === "drive.uc.cn") return "uc";
    if (host === "yun.139.com") return "mobile";
    return "";
  };

  $(".tgme_widget_message_wrap").each((i, el) => {
    if (results.length >= limit) return false;
    const root = $(el);
    const text = root.find(".tgme_widget_message_text").text().trim();
    const dateTitle = root.find("time").attr("datetime") || "";
    const postId = root.find(".tgme_widget_message").attr("data-post") || "";
    const firstLine = text.split("\n")[0] || text.slice(0, 80);

    if (!matchesSearchKeyword(text, keyword)) {
      return;
    }

    const links: { type: string; url: string; password: string }[] = [];
    const seenUrls = new Set<string>();
    const urlPattern = /https?:\/\/[A-Za-z0-9\-._~:\/?#\[\]@!$&'()*+,;=%]+/g;
    const passwdPattern = /(?:提取码|密码|pwd|pass)[:：\s]*([a-zA-Z0-9]{3,6})/i;

    const addUrl = (raw: string) => {
      const deproxied = deproxyUrl(raw);
      let host = "";
      try {
        host = new URL(deproxied).hostname || "";
      } catch {
        return;
      }
      const type = classifyByHostname(host);
      if (!type) return;

      const key = deproxied.toLowerCase();
      if (seenUrls.has(key)) return;
      seenUrls.add(key);

      const m = text.match(passwdPattern);
      const password = m ? m[1] : "";
      links.push({ type, url: deproxied, password });
    };

    const urlsFromText = text.match(urlPattern) || [];
    for (const u of urlsFromText) addUrl(u);

    root.find(".tgme_widget_message_text a[href]").each((_, a) => {
      const href = $(a).attr("href");
      if (href) addUrl(href);
    });

    let title = firstLine;
    for (const link of links) {
      const escaped = link.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      title = title.replace(new RegExp(escaped, "g"), "");
    }
    title = title
      .replace(
        /(名称|描述|链接|大小|标签|夸克|UC|百度|阿里|迅雷|115|天翼|123|移动|提取码|密码|📧|📿|：|,|\.|\||-|\s)+/g,
        " ",
      )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    if (!title) title = firstLine.slice(0, 80);

    let content = text;
    for (const link of links) {
      const escaped = link.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      content = content.replace(new RegExp(escaped, "g"), "");
      if (link.password) {
        content = content.replace(
          new RegExp(`(?:提取码|密码|pwd|pass)[:：\\s]*${link.password}`, "gi"),
          "",
        );
      }
    }
    content = content
      .replace(/(夸克|UC|百度|阿里|迅雷|115|天翼|123|移动|：|,|\.|\||-)+/g, "")
      .replace(/\s+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();

    results.push({
      message_id: postId,
      unique_id: `tg-${channel}-${postId || i}`,
      channel,
      datetime: dateTitle ? new Date(dateTitle).toISOString() : "",
      title,
      content,
      links,
    });
  });

  return results;
}

const TG_RAW_BODY_LIMIT = 30_000;

function snapshotResponse(
  status: number,
  headers: Headers | undefined,
  body: string,
): TgProbeResponseSnapshot {
  const headerRecord: Record<string, string> = {};
  headers?.forEach((value, key) => {
    headerRecord[key] = value;
  });
  return {
    status,
    headers: headerRecord,
    body: body.slice(0, TG_RAW_BODY_LIMIT),
    bodyLength: body.length,
    bodyTruncated: body.length > TG_RAW_BODY_LIMIT,
  };
}

/**
 * Lightweight diagnostic for the public-channel tester.
 * It only accepts a Telegram channel username and talks to two fixed public
 * web endpoints; it is not an arbitrary URL fetcher.
 */
export async function probeTgChannel(
  channel: string,
  keyword: string,
  limit = 20,
  options: TgFetchOptions = {},
): Promise<TgProbeResult> {
  const started = Date.now();
  const ua =
    options.userAgent ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
  const safeLimit = Math.min(50, Math.max(1, Math.floor(limit)));
  const baseUrl = `https://t.me/s/${encodeURIComponent(channel)}`;
  let route: TgProbeResult["route"] = "none";
  let status: number | null = null;
  let html = "";
  let lastError = "";
  const attempts: TgProbeAttempt[] = [];

  for (const candidate of [
    { url: baseUrl, route: "telegram" as const },
    { url: `https://r.jina.ai/${baseUrl}`, route: "jina" as const },
  ]) {
    const attemptStarted = Date.now();
    const request: TgProbeRequestSnapshot = {
      method: "GET",
      url: candidate.url,
      headers: { "user-agent": ua },
    };
    try {
      const response = await ofetch.raw<string>(candidate.url, {
        headers: request.headers,
        retry: 0,
        timeout: 10000,
      });
      status = response.status;
      html = typeof response._data === "string" ? response._data : "";
      route = candidate.route;
      attempts.push({
        route: candidate.route,
        request,
        response: snapshotResponse(response.status, response.headers, html),
        elapsedMs: Date.now() - attemptStarted,
      });
      if (html.includes("tgme_widget_message")) break;
    } catch (error: any) {
      const errorResponse = error?.response;
      const errorBody =
        typeof errorResponse?._data === "string" ? errorResponse._data : "";
      if (typeof errorResponse?.status === "number") {
        status = errorResponse.status;
      }
      lastError =
        error?.cause?.code || error?.code || error?.message || "请求失败";
      attempts.push({
        route: candidate.route,
        request,
        response:
          typeof errorResponse?.status === "number"
            ? snapshotResponse(
                errorResponse.status,
                errorResponse.headers,
                errorBody,
              )
            : null,
        elapsedMs: Date.now() - attemptStarted,
        error: lastError,
      });
    }
  }

  const elapsedMs = Date.now() - started;
  const lastAttempt = attempts[attempts.length - 1];
  const lastAttemptWithResponse =
    [...attempts].reverse().find((attempt) => attempt.response) || lastAttempt;
  const diagnostics = {
    attempts,
    upstreamRequest: lastAttemptWithResponse?.request || null,
    upstreamResponse: lastAttemptWithResponse?.response || null,
  };
  if (!html || !html.includes("tgme_widget_message")) {
    return {
      channel,
      keyword,
      state: lastError ? "error" : "warning",
      message: lastError
        ? `公开页面请求失败：${lastError}`
        : "页面可访问，但未识别到公开频道消息结构",
      elapsedMs,
      checkedAt: new Date().toISOString(),
      route,
      httpStatus: status,
      results: [],
      ...diagnostics,
    };
  }

  const results = parseChannelPage(load(html), channel, keyword, safeLimit);
  return {
    channel,
    keyword,
    state: results.length ? "available" : "warning",
    message: results.length
      ? `找到 ${results.length} 条匹配消息`
      : "频道可访问，但当前关键词没有提取到网盘链接",
    elapsedMs,
    checkedAt: new Date().toISOString(),
    route,
    httpStatus: status,
    results,
    ...diagnostics,
  };
}
