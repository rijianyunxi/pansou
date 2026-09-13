import { CodeSearchPlugin, type PluginSearchContext } from "./manager";
import type { SearchResult } from "../types/models";
import { fetchRawWithRetry, fetchWithRetry } from "../utils/fetch";
import { parseConfiguredUpstreamResponse } from "../parsers/upstream";
import { getConfiguredUpstream } from "../services/upstreamCatalog";

// 轻量版：直接请求 pansearch 的 _next data 接口

type Item = { id: number; content: string; pan: string; time?: string };
type Resp = { pageProps: { data: { total: number; data: Item[] } } };

const DATA = (origin: string, buildId: string) =>
  `${origin}/_next/data/${buildId}/search.json`;

export class PansearchPlugin extends CodeSearchPlugin {
  constructor() {
    super({ id: "pansearch", name: "pansearch", priority: 3 });
  }
  override async search(context: PluginSearchContext): Promise<SearchResult[]> {
    const { keyword, signal, timeoutMs } = context;
    const source = getConfiguredUpstream("pansearch");
    if (!source || source.enabled === false) return [];
    const origin = new URL(source.url).origin;
    let buildId = await getBuildId(signal, source.url).catch(() => "");
    if (!buildId) return [];
    let response = await fetchData(origin, buildId, keyword, signal, timeoutMs, source.method).catch(() => undefined);
    if (!response) {
      buildId = await getBuildId(signal, source.url, true).catch(() => "");
      if (buildId) response = await fetchData(origin, buildId, keyword, signal, timeoutMs, source.method).catch(() => undefined);
    }
    if (response) {
      const configured = await parseConfiguredUpstreamResponse("pansearch", response.data, source.format, {
        keyword,
        rawBody: response.rawBody,
        url: `${DATA(origin, buildId)}?keyword=${encodeURIComponent(keyword)}&offset=0`,
        page: 1,
      });
      if (configured) return configured;
    }
    const items = response?.data.pageProps?.data?.data || [];
    const out: SearchResult[] = [];
    for (const it of items) {
      const link = extractLink(it.content);
      if (!link.url) continue;
      out.push({
        message_id: "",
        unique_id: `pansearch-${it.id}`,
        channel: "",
        datetime: it.time || "",
        title: extractTitle(it.content, keyword),
        content: cleanHTML(it.content),
        links: [
          { type: mapType(link.url), url: link.url, password: link.password },
        ],
      });
    }
    return out;
  }
}

let buildIdCache: {
  website: string;
  buildId: string;
  expiresAt: number;
  request?: Promise<string>;
} = { website: "", buildId: "", expiresAt: 0 };

async function fetchData(
  origin: string,
  buildId: string,
  keyword: string,
  signal: AbortSignal,
  timeout: number,
  method: "GET" | "POST"
): Promise<{ data: Resp; rawBody: string }> {
  const url = `${DATA(origin, buildId)}?keyword=${encodeURIComponent(keyword)}&offset=0`;
  const rawBody = await fetchRawWithRetry(
    url,
    { method, body: method === "POST" ? JSON.stringify({ keyword }) : undefined, headers: { "user-agent": "Mozilla/5.0", ...(method === "POST" ? { "content-type": "application/json" } : {}) }, signal },
    { maxRetries: 1, timeout, signal },
  );
  return { data: JSON.parse(rawBody) as Resp, rawBody };
}

async function getBuildId(signal: AbortSignal, website: string, force = false): Promise<string> {
  if (!force && buildIdCache.website === website && buildIdCache.buildId && Date.now() < buildIdCache.expiresAt) {
    return buildIdCache.buildId;
  }
  if (!force && buildIdCache.website === website && buildIdCache.request) {
    return buildIdCache.request;
  }
  buildIdCache = { website, buildId: "", expiresAt: 0 };
  const request = fetchBuildId(signal, website).then((buildId) => {
    if (buildIdCache.website === website) {
      buildIdCache.buildId = buildId;
      buildIdCache.expiresAt = Date.now() + 30 * 60 * 1000;
    }
    return buildId;
  }).finally(() => {
    if (buildIdCache.website === website) delete buildIdCache.request;
  });
  buildIdCache.request = request;
  return request;
}

async function fetchBuildId(signal: AbortSignal, website: string): Promise<string> {
  const html = await fetchWithRetry<string>(
    website,
    {
      headers: { "user-agent": "Mozilla/5.0" },
      signal,
    },
    {
      maxRetries: 2,
      timeout: 8000,
      signal,
    }
  );
  const m = /"buildId":"([^"]+)"/.exec(html);
  const matchedBuildId = m?.[1];
  if (matchedBuildId) return matchedBuildId;
  const m2 =
    /<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s.exec(
      html
    );
  const nextData = m2?.[1];
  if (nextData) {
    try {
      const data = JSON.parse(nextData);
      if (data?.buildId) return String(data.buildId);
    } catch {}
  }
  throw new Error("no buildId");
}

function extractLink(content: string): { url: string; password: string } {
  // 简单从 a 标签与 pwd 参数提取
  const mHref = /href=\"([^\"]+)\"/.exec(content);
  const url = mHref?.[1] ?? "";
  let password = "";
  const mPwd = /[?&]pwd=([^"&#]+)/.exec(content);
  if (mPwd?.[1]) password = mPwd[1];
  return { url, password };
}
function extractTitle(content: string, keyword: string): string {
  const m = /名称：([^<\n]+)/.exec(content);
  if (m?.[1]) return cleanHTML(m[1]);
  return keyword;
}
function cleanHTML(html: string): string {
  return html
    .replace(/<span class='highlight-keyword'>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function mapType(url: string): string {
  const u = url.toLowerCase();
  if (u.startsWith("magnet:")) return "magnet";
  if (u.startsWith("ed2k:")) return "ed2k";
  if (u.includes("pan.baidu.com")) return "baidu";
  if (u.includes("alipan.com") || u.includes("aliyundrive.com"))
    return "aliyun";
  if (u.includes("pan.quark.cn")) return "quark";
  if (u.includes("cloud.189.cn")) return "tianyi";
  if (u.includes("pan.xunlei.com")) return "xunlei";
  if (u.includes("caiyun") || u.includes("yun.139.com")) return "mobile";
  if (u.includes("115.com")) return "115";
  if (u.includes("123pan.com")) return "123";
  if (u.includes("drive.uc.cn")) return "uc";
  if (u.includes("mypikpak.com")) return "pikpak";
  if (u.includes("lanzou")) return "lanzou";
  return "others";
}
