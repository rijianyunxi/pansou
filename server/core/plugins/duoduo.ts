import { CodeSearchPlugin, type PluginSearchContext } from "./manager";
import type { SearchResult } from "../types/models";
import { load } from "cheerio";
import { fetchWithRetry } from "../utils/fetch";
import { parseConfiguredUpstreamResponse } from "../parsers/upstream";
import { getConfiguredUpstream } from "../services/upstreamCatalog";

function configuredBase(): string {
  return getConfiguredUpstream("duoduo")?.url || "";
}
function searchUrl(kw: string): string {
  const base = configuredBase().replace(/\/$/, "");
  return /\/index\.php\/vod\/search/i.test(base)
    ? `${base}/wd/${encodeURIComponent(kw)}.html`
    : `${base}/index.php/vod/search/wd/${encodeURIComponent(kw)}.html`;
}

const re = {
  magnet: /magnet:\?xt=urn:btih:[0-9a-fA-F]{40}[^"'\s]*/g,
  ed2k: /ed2k:\/\/\|file\|.+\|\d+\|[0-9a-fA-F]{32}\|\//g,
  pan: {
    baidu:
      /https?:\/\/pan\.baidu\.com\/s\/[0-9a-zA-Z_-]+(?:\?pwd=[0-9a-zA-Z]+)?/g,
    aliyun:
      /https?:\/\/(?:www\.)?(?:aliyundrive\.com|alipan\.com)\/s\/[0-9a-zA-Z_-]+/g,
    tianyi: /https?:\/\/cloud\.189\.cn\/t\/[0-9a-zA-Z_-]+/g,
    uc: /https?:\/\/drive\.uc\.cn\/s\/[0-9a-fA-F]+(?:\?[^"\s]*)?/g,
    mobile: /https?:\/\/(?:caiyun\.139|caiyun\.feixin\.10086|yun\.139)\.com\/[^"\s]+/g,
    oneonefive: /https?:\/\/(?:115\.com|115cdn\.com)\/s\/[0-9a-zA-Z_-]+/g,
    pikpak: /https?:\/\/mypikpak\.com\/s\/[0-9a-zA-Z_-]+/g,
    xunlei:
      /https?:\/\/pan\.xunlei\.com\/s\/[0-9a-zA-Z_-]+(?:\?pwd=[0-9a-zA-Z]+)?/g,
    _123: /https?:\/\/(?:www\.)?123pan\.com\/s\/[0-9a-zA-Z_-]+/g,
    lanzou: /https?:\/\/(?:www\.)?(?:lanzou|lanzo)[^\s]+/g,
  },
};

function collectLinks(html: string): SearchResult["links"] {
  const links: SearchResult["links"] = [];
  const add = (url: string, type: string) => {
    if (!url) return;
    if (links.some((l) => l.url === url)) return;
    links.push({ type, url, password: "" });
  };
  for (const m of html.match(re.magnet) || []) add(m, "magnet");
  for (const m of html.match(re.ed2k) || []) add(m, "ed2k");
  for (const [type, rg] of Object.entries(re.pan))
    for (const m of html.match(rg as RegExp) || []) add(m, type);
  return links;
}

async function fetchDetail(url: string, signal: AbortSignal) {
  const html = await fetchWithRetry<string>(
    url,
    {
      headers: { "user-agent": "Mozilla/5.0", referer: new URL(configuredBase()).origin + "/" },
    },
    {
      maxRetries: 2,
      timeout: 10000,
      signal,
    }
  ).catch(() => "");
  if (!html) return [];
  const $ = load(html);
  const text = $("#download-list").html() || $("body").html() || "";
  return collectLinks(text);
}

export class DuoduoPlugin extends CodeSearchPlugin {
  constructor() {
    super({ id: "duoduo", name: "duoduo", priority: 2 });
  }
  override async search(context: PluginSearchContext): Promise<SearchResult[]> {
    const { keyword, signal } = context;
    const source = getConfiguredUpstream("duoduo");
    if (!source || source.enabled === false) return [];
    const url = searchUrl(keyword);
    const html = await fetchWithRetry<string>(
      url,
      {
        method: source.method,
        body: source.method === "POST" ? JSON.stringify({ keyword }) : undefined,
        headers: { "user-agent": "Mozilla/5.0", referer: new URL(configuredBase()).origin + "/", ...(source.method === "POST" ? { "content-type": "application/json" } : {}) },
      },
      {
        maxRetries: 2,
        timeout: 10000,
          signal,
      }
    ).catch(() => "");
    if (!html) return [];
    const configured = await parseConfiguredUpstreamResponse("duoduo", html, source.format, {
      keyword,
      url,
      page: 1,
    });
    if (configured) return configured;
    const $ = load(html);
    const out: SearchResult[] = [];
    const tasks: Promise<any>[] = [];
    $(".module-search-item").each((_, el) => {
      const s = $(el);
      const a = s.find(".video-info-header h3 a").first();
      const href = a.attr("href") || "";
      const title = a.text().trim();
      if (!href || !title) return;
      const detail = href.startsWith("/") ? `${new URL(source.url).origin}${href}` : href;
      tasks.push(
        (async () => {
          const links = await fetchDetail(detail, signal);
          if (links.length) {
            out.push({
              message_id: "",
              unique_id: `duoduo-${detail}`,
              channel: "",
              datetime: "",
              title,
              content: "",
              links,
            });
          }
        })()
      );
    });
    // 使用 Promise.allSettled 并行获取所有详情
    await Promise.allSettled(tasks);
    return out;
  }
}
