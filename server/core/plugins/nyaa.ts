import { CodeSearchPlugin, type PluginSearchContext } from "./manager";
import type { SearchResult } from "../types/models";
import { ofetch } from "ofetch";
import { load, type CheerioAPI } from "cheerio";
import { parseConfiguredUpstreamResponse } from "../parsers/upstream";
import { getConfiguredUpstream } from "../services/upstreamCatalog";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

/** 分页上限：防止关键词命中过多或分页解析异常时请求失控。 */
const MAX_PAGES = 5;
/** 翻页前必须为下一页预留的时间预算（毫秒），不足则提前停止。 */
const NEXT_PAGE_RESERVE_MS = 300;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_RESULTS = 100;

/** Nyaa 上游时间戳的合理区间：早于 2005-01-01 或晚于现在+24h 的视为异常丢弃。 */
const MIN_TS_MS = Date.UTC(2005, 0, 1);
const FUTURE_SLOP_MS = 24 * 60 * 60 * 1000;

const CLOUDFLARE_RE =
  /just a moment|cf-chl|challenge-platform|attention required|cf-browser-verification|checking your browser|captcha/i;

const MAGNET_RE = /^magnet:\?xt=urn:btih:[0-9a-z]{32,}/i;
const RELATIVE_TIME_RE = /^(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago$/i;
const ABSOLUTE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/;
const UNIT_MS: Record<string, number> = {
  second: 1000,
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  year: 365 * 24 * 60 * 60 * 1000,
};

export type NyaaPageKind = "results" | "empty";

export interface NyaaParsedRow {
  /** /view/{id} 中的数字 id，解析不到时为空字符串。 */
  torrentId: string;
  title: string;
  /** 合法 magnet:?xt=urn:btih:... 链接，无效/缺失时为空字符串。 */
  magnet: string;
  /** .torrent 文件下载链接（绝对地址），缺失时为空字符串。 */
  torrentUrl: string;
  /** 人类可读大小，如 "1.3 GiB"。 */
  size: string;
  /** 发布时间（ISO 8601 UTC）。解析不到/异常时为空字符串。 */
  datetime: string;
  seeders: number | null;
  leechers: number | null;
  downloads: number | null;
}

export interface NyaaPage {
  kind: NyaaPageKind;
  items: NyaaParsedRow[];
  /** 下一页页码（由分页链接推断），null 表示没有下一页。 */
  nextPage: number | null;
}

/** 构造搜索页 URL：f=0 无过滤、c=0_0 全部分类、按做种数降序；page>1 时带 p 参数。 */
export function buildSearchUrl(keyword: string, page = 1, baseUrl?: string): string {
  const base = (baseUrl || getConfiguredUpstream("nyaa")?.url || "").replace(/\/+$/, "");
  const params = new URLSearchParams({
    f: "0",
    c: "0_0",
    q: keyword,
    s: "seeders",
    o: "desc",
  });
  if (page > 1) params.set("p", String(page));
  return `${base}/?${params.toString()}`;
}

function buildConfiguredSearchUrl(baseUrl: string, keyword: string, page = 1): string {
  const parsed = new URL(baseUrl);
  const params = new URLSearchParams({ f: "0", c: "0_0", q: keyword, s: "seeders", o: "desc" });
  if (page > 1) params.set("p", String(page));
  for (const [key, value] of params) parsed.searchParams.set(key, value);
  return parsed.toString();
}

/**
 * 发布时间映射：优先 data-timestamp（Unix 秒），回退相对时间文本
 * （"3 hours ago"/"just now"/"yesterday"），再回退 UTC 绝对时间
 * （"YYYY-MM-DD HH:MM"）。越界/无法解析的异常值一律返回空字符串丢弃。
 */
export function parseNyaaTimestamp(
  rawText: string,
  dataTimestamp: string | undefined,
  now: number = Date.now()
): string {
  const candidates: number[] = [];
  if (dataTimestamp) {
    const value = Number(dataTimestamp);
    if (Number.isFinite(value) && value > 0) {
      candidates.push(value < 1e12 ? value * 1000 : value);
    }
  }
  const text = rawText.trim().toLowerCase();
  const dayMs = UNIT_MS.day;
  if (text === "just now") {
    candidates.push(now);
  } else if (text === "yesterday" && dayMs) {
    candidates.push(now - dayMs);
  } else {
    const relative = RELATIVE_TIME_RE.exec(text);
    if (relative) {
      const unit = UNIT_MS[relative[2]!];
      const value = Number(relative[1]);
      if (unit && value > 0) candidates.push(now - value * unit);
    }
  }
  const absolute = ABSOLUTE_TIME_RE.exec(rawText.trim());
  if (absolute) {
    const parsed = Date.parse(
      `${absolute[1]}-${absolute[2]}-${absolute[3]}T${absolute[4]}:${absolute[5]}:00Z`
    );
    if (!Number.isNaN(parsed)) candidates.push(parsed);
  }
  for (const ms of candidates) {
    if (ms >= MIN_TS_MS && ms <= now + FUTURE_SLOP_MS) {
      return new Date(ms).toISOString();
    }
  }
  return "";
}

function parseNumberCell(text: string): number | null {
  const value = Number.parseInt(text.replace(/[,\s]/g, ""), 10);
  return Number.isFinite(value) ? value : null;
}

function parseNextPage($: CheerioAPI, currentPage: number): number | null {
  let maxPage = 0;
  $("ul.pagination a[href]").each((_, a) => {
    const href = $(a).attr("href") || "";
    const match = /[?&]p=(\d+)/.exec(href);
    if (match) maxPage = Math.max(maxPage, Number(match[1]));
  });
  return maxPage > currentPage ? currentPage + 1 : null;
}

/**
 * 解析一个搜索结果页。真实空结果（"No results found" 标记）返回 kind="empty"；
 * Cloudflare 验证页或结构变化（表格缺失/0 行可解析且无空结果标记）直接抛错，
 * 由 PluginManager 的错误收集器转为搜索 warning，绝不静默当作零结果。
 */
export function parseSearchPage(html: string, currentPage = 1, now: number = Date.now(), baseUrl = getConfiguredUpstream("nyaa")?.url || ""): NyaaPage {
  if (CLOUDFLARE_RE.test(html)) {
    throw new Error("nyaa: 上游返回 Cloudflare 验证页，请求被拦截");
  }
  if (/no results found/i.test(html)) {
    return { kind: "empty", items: [], nextPage: null };
  }
  const $ = load(html);
  const table = $("table.torrent-list");
  if (!table.length) {
    throw new Error("nyaa: 搜索页结构可能已变化（未找到 torrent-list 结果表格）");
  }
  const parseRow = (row: ReturnType<typeof $>): NyaaParsedRow | null => {
    const tds = row.find("td");
    // 最少需要 category / name / link / size / date 五列。
    if (tds.length < 5) return null;
    const titleA = tds.eq(1).find('a[href^="/view/"]').not(".comments").first();
    const title = (titleA.text() || titleA.attr("title") || "").trim();
    const viewHref = titleA.attr("href") || "";
    if (!title && !viewHref) return null;
    const idMatch = /\/view\/(\d+)/.exec(viewHref);
    const magnetRaw = row.find('a[href^="magnet:"]').first().attr("href") || "";
    const torrentHref =
      row.find('a[href$=".torrent"], a[href*="/download/"]').first().attr("href") || "";
    const dateTd = tds.eq(4);
    return {
      torrentId: idMatch ? idMatch[1]! : "",
      title,
      magnet: MAGNET_RE.test(magnetRaw) ? magnetRaw : "",
      torrentUrl:
        torrentHref && !/^https?:\/\//i.test(torrentHref) ? `${new URL(baseUrl).origin}${torrentHref}` : torrentHref,
      size: tds.eq(3).text().trim(),
      datetime: parseNyaaTimestamp(dateTd.text(), dateTd.attr("data-timestamp"), now),
      seeders: tds.length > 5 ? parseNumberCell(tds.eq(5).text()) : null,
      leechers: tds.length > 6 ? parseNumberCell(tds.eq(6).text()) : null,
      downloads: tds.length > 7 ? parseNumberCell(tds.eq(7).text()) : null,
    };
  };
  const items: NyaaParsedRow[] = [];
  table.find("tbody tr").each((_, tr) => {
    const parsed = parseRow($(tr));
    if (parsed) items.push(parsed);
  });
  if (!items.length) {
    throw new Error("nyaa: 搜索页结构可能已变化（结果表格存在但 0 行可解析）");
  }
  return { kind: "results", items, nextPage: parseNextPage($, currentPage) };
}

/** 行数据 → 统一结果。磁力/种子链接都没有的行返回 null（调用方跳过）。 */
export function rowToSearchResult(row: NyaaParsedRow): SearchResult | null {
  const links: SearchResult["links"] = [];
  if (row.magnet) links.push({ type: "magnet", url: row.magnet, password: "" });
  if (row.torrentUrl) links.push({ type: "torrent", url: row.torrentUrl, password: "" });
  if (!links.length) return null;
  const parts: string[] = [];
  if (row.size) parts.push(`Size: ${row.size}`);
  if (row.seeders !== null) parts.push(`Seeders: ${row.seeders}`);
  if (row.leechers !== null) parts.push(`Leechers: ${row.leechers}`);
  if (row.downloads !== null) parts.push(`Downloads: ${row.downloads}`);
  return {
    message_id: "",
    unique_id: `nyaa-${row.torrentId || row.title}`,
    channel: "",
    datetime: row.datetime,
    title: row.title,
    content: parts.join(" | "),
    links,
  };
}

export class NyaaPlugin extends CodeSearchPlugin {
  constructor() {
    super({
      id: "nyaa",
      name: "nyaa",
      version: "1.1.0",
      priority: 4,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxResults: DEFAULT_MAX_RESULTS,
      outputTypes: ["magnet", "torrent"],
    });
  }

  protected resolveMaxResults(): number {
    return Math.max(1, this.manifest.maxResults || DEFAULT_MAX_RESULTS);
  }

  /** 单页请求：网络/HTTP 失败抛出带 nyaa: 前缀的错误（转为搜索 warning）；取消时原样透传。 */
  protected async fetchText(url: string, signal: AbortSignal, timeoutMs: number, method: "GET" | "POST" = "GET", keyword?: string, page = 1): Promise<string> {
    try {
      return await ofetch<string>(url, {
        method,
        body: method === "POST" ? JSON.stringify({ q: keyword || "", page }) : undefined,
        headers: { "user-agent": USER_AGENT, referer: `${new URL(url).origin}/` },
        signal,
        timeout: Math.max(1, Math.ceil(timeoutMs)),
        retry: 0,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      const statusCode = (error as { statusCode?: number } | undefined)?.statusCode;
      const reason = statusCode
        ? `HTTP ${statusCode}`
        : error instanceof Error
          ? error.message
          : String(error);
      throw new Error(`nyaa: 搜索页请求失败 (${reason})`, { cause: error });
    }
  }

  override async search(context: PluginSearchContext): Promise<SearchResult[]> {
    const { keyword, signal } = context;
    const source = getConfiguredUpstream("nyaa");
    if (!source || source.enabled === false) return [];
    const maxResults = this.resolveMaxResults();
    const deadline =
      Date.now() + Math.max(1, context.timeoutMs > 0 ? context.timeoutMs : DEFAULT_TIMEOUT_MS);
    const out: SearchResult[] = [];
    const configuredOut: SearchResult[] = [];
    const seen = new Set<string>();
    let configuredMode = false;
    let page = 1;

    while (page >= 1 && page <= MAX_PAGES) {
      signal.throwIfAborted();
      const remainingMs = deadline - Date.now();
      if (page > 1 && remainingMs <= NEXT_PAGE_RESERVE_MS) break;
      const pageUrl = buildConfiguredSearchUrl(source.url, keyword, page);
      const html = await this.fetchText(
        pageUrl,
        signal,
        page > 1 ? remainingMs - NEXT_PAGE_RESERVE_MS : remainingMs,
        source.method,
        keyword,
        page,
      );
      const configured = await parseConfiguredUpstreamResponse("nyaa", html, source.format, {
        keyword,
        url: pageUrl,
        page,
      });
      if (configured !== null) {
        configuredMode = true;
        for (const result of configured) {
          if (configuredOut.length >= maxResults) break;
          if (seen.has(result.unique_id)) continue;
          seen.add(result.unique_id);
          configuredOut.push(result);
        }
        // A configured parser owns the response shape, so do not force the
        // built-in Nyaa table parser just to discover pagination. Nyaa's
        // numeric page URL is stable; an empty custom page ends the scan.
        if (configured.length === 0 || configuredOut.length >= maxResults) break;
        page += 1;
        continue;
      }
      const parsed = parseSearchPage(html, page, Date.now(), source.url);
      if (parsed.kind === "empty") break;
      let addedThisPage = 0;
      for (const row of parsed.items) {
        if (out.length >= maxResults) break;
        const result = rowToSearchResult(row);
        if (!result || seen.has(result.unique_id)) continue;
        seen.add(result.unique_id);
        out.push(result);
        addedThisPage++;
      }
      if (out.length >= maxResults) break;
      if (parsed.items.length > 0 && addedThisPage === 0) {
        if (page === 1) {
          throw new Error("nyaa: 搜索页结构可能已变化（有结果行但未解析出磁力/种子链接）");
        }
        break;
      }
      if (parsed.nextPage === null) break;
      page = parsed.nextPage;
    }
    return configuredMode ? configuredOut : out;
  }
}
