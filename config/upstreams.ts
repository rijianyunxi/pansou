export interface AdapterMapping {
  /** JSON dot path or HTML item selector. */
  items: string;
  /** JSON field path or HTML selector. */
  title: string;
  /** JSON field path or HTML URL selector; empty means the current link node. */
  url: string;
  type: string;
  password: string;
  linkArray?: string;
  content?: string;
  datetime?: string;
}

export interface UpstreamRetryConfig {
  /** Retries after the first request for each URL (0-3). */
  maxRetries?: number;
  /** Delay before retrying the same URL, capped by the runtime (0-5000ms). */
  delayMs?: number;
}

export interface UpstreamRequestConfig {
  /** Optional override for the actual request URL; supports {{keyword}} and stage variables. */
  url?: string;
  /** Explicit fallback endpoints tried after the primary URL is exhausted. */
  fallbackUrls?: string[];
  /** Bounded retry policy applied independently to every endpoint. */
  retry?: UpstreamRetryConfig;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  bodyType?: "json" | "form";
  body?: unknown;
  timeoutMs?: number;
  maxResponseBytes?: number;
  redirect?: "error" | "follow";
  allowedDomains?: string[];
  maxRequestBodyBytes?: number;
  secrets?: string[];
  stages?: unknown[];
}

export interface UpstreamResponseConfig {
  nextPage?: {
    selector?: string;
    queryParam?: string;
    maxPages?: number;
  };
}

export type UpstreamSourceKind = "http" | "telegram";

/** Stable options exposed to the management console; labels are configurable per source. */
export const UPSTREAM_DRIVE_TYPES = [
  { value: "mixed", label: "聚合" },
  { value: "aliyun", label: "阿里云盘" },
  { value: "quark", label: "夸克" },
  { value: "baidu", label: "百度网盘" },
  { value: "115", label: "115" },
  { value: "tianyi", label: "天翼云盘" },
  { value: "uc", label: "UC 网盘" },
  { value: "magnet", label: "磁力" },
  { value: "other", label: "其他" },
] as const;

export const UPSTREAM_RESOURCE_TYPES = [
  { value: "movie", label: "电影" },
  { value: "tv", label: "剧集" },
  { value: "anime", label: "动漫" },
  { value: "novel", label: "小说" },
  { value: "music", label: "音乐" },
  { value: "document", label: "资料" },
  { value: "software", label: "软件" },
  { value: "game", label: "游戏" },
  { value: "other", label: "其他" },
] as const;

export interface UpstreamDefinition {
  id: string;
  /** One directory model for HTTP endpoints and Telegram channel sources. */
  sourceKind?: UpstreamSourceKind;
  /** Public Telegram username when sourceKind is telegram. */
  channel?: string;
  name: string;
  description: string;
  url: string;
  /** Ordered URLs tried after the primary request fails. */
  fallbackUrls?: string[];
  /** Management labels, independent from drive/resource classification. */
  tags?: string[];
  /** Cloud drive category, e.g. aliyun, quark, baidu, magnet. */
  driveType?: string;
  /** Resource categories, e.g. movie, anime, novel, music, document. */
  resourceTypes?: string[];
  method: "GET" | "POST";
  format: "json" | "html";
  plugin: string;
  adapter: string;
  color: string;
  initials: string;
  mapping: AdapterMapping;
  builtin: boolean;
  /** Whether this configured source participates in formal search. */
  enabled?: boolean;
  /** Optional complex execution capability retained in core; endpoint settings remain editable. */
  runtime?: { kind: "core"; handler: string; urls?: string[] };
  /** Declarative request/response details used by the generic configured executor. */
  request?: UpstreamRequestConfig;
  /** Top-level retry policy accepted for catalog/API compatibility. */
  retry?: UpstreamRetryConfig;
  /** Sandboxed synchronous transform(payload, $, context) source. */
  transform?: string;
  response?: UpstreamResponseConfig;
}

const diskMapping: AdapterMapping = {
  items: "data.list",
  title: "disk_name",
  url: "link",
  type: "disk_type",
  password: "disk_pass",
};
const htmlMapping: AdapterMapping = {
  items: "",
  title: "",
  url: "",
  type: "",
  password: "",
};

// Every shipped source is a regular configured function plugin. Core handlers
// remain available only as a compatibility fallback for old rows without this
// transform field.
const HUNHEPAN_TRANSFORM = `function transform(payload, $, context) {
  var list = payload && payload.data && Array.isArray(payload.data.list) ? payload.data.list : [];
  return list.map(function (item) {
    return {
      unique_id: item.disk_id || item.doc_id || "",
      title: item.disk_name || "",
      content: item.files || "",
      links: [{ url: item.link || "", type: item.disk_type || "", password: item.disk_pass || "" }]
    };
  });
}`;

const NYAA_TRANSFORM = `function transform(payload, $, context) {
  if (!$) return [];
  return $("table.torrent-list tbody tr").toArray().map(function (row) {
    var item = $(row);
    var title = item.find('td').eq(1).find('a[href^="/view/"]').first().text().trim();
    var magnet = item.find('a[href^="magnet:"]').first().attr("href") || "";
    var date = item.find("td").eq(4).attr("data-timestamp") || item.find("td").eq(4).text().trim();
    return { title: title, datetime: date, links: [{ url: magnet, type: "magnet" }] };
  });
}`;

const PANSEARCH_TRANSFORM = `function transform(payload, $, context) {
  var list = payload && payload.pageProps && payload.pageProps.data && Array.isArray(payload.pageProps.data.data) ? payload.pageProps.data.data : [];
  return list.map(function (item) {
    var raw = String(item.content || "");
    var match = raw.match(/https?:\/\/[^\s"'<>]+/);
    return {
      unique_id: item.id || "",
      title: raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(),
      content: raw,
      datetime: item.time || "",
      links: [{ url: match ? match[0] : "" }]
    };
  });
}`;

const DUODUO_TRANSFORM = `function transform(payload, $, context) {
  var html = String(payload || "");
  var links = html.match(/(?:https?:\/\/[^\s"'<>]+(?:pan\.[^\s"'<>]+|aliyundrive\.com[^\s"'<>]+|alipan\.com[^\s"'<>]+|123pan\.com[^\s"'<>]+|115\.com[^\s"'<>]+|mypikpak\.com[^\s"'<>]+))/g) || [];
  var unique = [];
  return links.filter(function (url) {
    if (unique.indexOf(url) >= 0) return false;
    unique.push(url);
    return true;
  }).map(function (url, index) {
    return { unique_id: "duoduo-" + index, title: context.keyword, links: [{ url: url }] };
  });
}`;

/** Default transforms offered when resetting a built-in upstream in the editor. */
export const DEFAULT_UPSTREAM_TRANSFORMS: Readonly<Record<string, string>> = {
  hunhepan: HUNHEPAN_TRANSFORM,
  nyaa: NYAA_TRANSFORM,
  pansearch: PANSEARCH_TRANSFORM,
  duoduo: DUODUO_TRANSFORM,
};

export function getDefaultUpstreamTransform(id: string): string | undefined {
  return DEFAULT_UPSTREAM_TRANSFORMS[id];
}

export const BUILTIN_UPSTREAMS: UpstreamDefinition[] = [
  {
    id: "hunhepan",
    name: "混合盘",
    description: "混合盘主搜索接口",
    tags: ["网盘", "聚合"],
    driveType: "mixed",
    resourceTypes: ["movie", "anime", "novel", "music", "document"],
    fallbackUrls: ["https://qkpanso.com/v1/search/disk", "https://kuake8.com/v1/search/disk"],
    url: "https://hunhepan.com/open/search/disk",
    method: "POST",
    format: "json",
    plugin: "hunhepan",
    adapter: "disk-json",
    color: "#5964d9",
    initials: "H",
    mapping: { ...diskMapping },
    builtin: true,
    enabled: true,
    runtime: { kind: "core", handler: "hunhepan", urls: ["https://hunhepan.com/open/search/disk", "https://qkpanso.com/v1/search/disk", "https://kuake8.com/v1/search/disk"] },
    request: {
      bodyType: "json",
      body: { q: "{{keyword}}", exact: true, page: "{{page}}", size: 30, type: "", time: "", from: "web", user_id: 0, filter: true },
      headers: { "user-agent": "Mozilla/5.0" },
      timeoutMs: 10000,
    },
    transform: HUNHEPAN_TRANSFORM,
  },
  {
    id: "nyaa",
    name: "Nyaa",
    description: "动漫与磁力资源",
    tags: ["磁力", "动漫"],
    driveType: "magnet",
    resourceTypes: ["anime"],
    url: "https://nyaa.si/",
    method: "GET",
    format: "html",
    plugin: "nyaa",
    adapter: "nyaa-html",
    color: "#398b70",
    initials: "N",
    mapping: { ...htmlMapping },
    builtin: true,
    enabled: true,
    runtime: { kind: "core", handler: "nyaa" },
    request: {
      query: { f: "0", c: "0_0", q: "{{keyword}}", s: "seeders", o: "desc" },
      headers: { "user-agent": "Mozilla/5.0" },
      timeoutMs: 10000,
    },
    transform: NYAA_TRANSFORM,
    response: { nextPage: { queryParam: "p", maxPages: 3 } },
  },
  {
    id: "pansearch",
    name: "PanSearch",
    description: "Next.js 数据接口",
    tags: ["网盘", "聚合"],
    driveType: "mixed",
    resourceTypes: ["movie", "anime", "novel", "music", "document"],
    url: "https://www.pansearch.me/search",
    method: "GET",
    format: "json",
    plugin: "pansearch",
    adapter: "next-data",
    color: "#4085b8",
    initials: "P",
    mapping: { ...htmlMapping },
    builtin: true,
    enabled: true,
    runtime: { kind: "core", handler: "pansearch" },
    request: {
      url: "https://www.pansearch.me/_next/data/{{buildId}}/search.json",
      query: { keyword: "{{keyword}}", offset: "0" },
      headers: { "user-agent": "Mozilla/5.0" },
      timeoutMs: 10000,
      stages: [{
        url: "https://www.pansearch.me/search",
        headers: { "user-agent": "Mozilla/5.0" },
        response: { format: "html", vars: { buildId: { selector: "#__NEXT_DATA__", source: "text", regex: { pattern: "\"buildId\":\"([^\"]+)" } } } }
      }],
    },
    transform: PANSEARCH_TRANSFORM,
  },
  {
    id: "duoduo",
    name: "多多",
    description: "影视资源 · 搜索页探测",
    tags: ["影视", "网盘"],
    driveType: "mixed",
    resourceTypes: ["movie", "tv"],
    url: "https://tv.yydsys.top",
    method: "GET",
    format: "html",
    plugin: "duoduo",
    adapter: "html-probe",
    color: "#c18b40",
    initials: "D",
    mapping: { ...htmlMapping },
    builtin: true,
    enabled: true,
    runtime: { kind: "core", handler: "duoduo" },
    request: {
      url: "https://tv.yydsys.top/index.php/vod/search/wd/{{keyword}}.html",
      headers: { "user-agent": "Mozilla/5.0" },
      timeoutMs: 10000,
    },
    transform: DUODUO_TRANSFORM,
  },
];

export function buildUpstreamRequest(id: string, keyword: string) {
  const source = BUILTIN_UPSTREAMS.find((s) => s.id === id);
  if (!source) throw new Error("Unknown built-in upstream");
  let url = source.url;
  let body: Record<string, unknown> | undefined;
  const kw = encodeURIComponent(keyword);
  if (id === "hunhepan")
    body = {
      q: keyword,
      exact: true,
      page: 1,
      size: 30,
      type: "",
      time: "",
      from: "web",
      user_id: 0,
      filter: true,
    };
  else if (id === "nyaa") url += `?f=0&c=0_0&q=${kw}&s=seeders&o=desc`;
  else if (id === "duoduo")
    url += `/index.php/vod/search/wd/${kw}.html`;
  return { url, method: source.method, body };
}

export type ProbeState = "available" | "warning" | "error";
export interface ProbeTrace {
  url: string;
  method: string;
  status: number | null;
  elapsedMs: number;
  bytes: number;
  contentType: string;
  error?: string;
}
export interface UpstreamProbe {
  sourceId: string;
  checkedAt: string;
  state: ProbeState;
  message: string;
  elapsedMs: number;
  httpStatus: number | null;
  businessCode?: string;
  traces: ProbeTrace[];
  raw: string;
  rawTruncated: boolean;
  results: import("../server/core/types/models").SearchResult[];
}
