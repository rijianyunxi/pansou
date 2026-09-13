import { getSqliteDatabase } from "../storage/sqlite";
import { validateOutboundUrl } from "../security/outboundUrl";
import { buildTgSourceUrl } from "../../../utils/tgSourceUrl";
import { validateParserCode } from "../parsers/repository";

/** Default Telegram transform executed by the common parser runtime. */
export const DEFAULT_TG_TRANSFORM = String.raw`function transform(payload, $, context) {
  const keyword = String(context.keyword || "").trim().toLowerCase();
  const normalize = (value) => String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const matches = (value) => !keyword || normalize(value).includes(normalize(keyword));
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const passwordOf = (value) => String(value || "").match(/(?:提取码|密码|pwd|pass)[:：\s]*([a-zA-Z0-9]{3,8})/i)?.[1] || "";
  const isResource = (value) => {
    const url = String(value || "").trim();
    return /^https?:\/\/(?![^/]*@)(?!t\.me(?:[/:]|$))(?!r\.jina\.ai(?:[/:]|$))(?:[^/]+\.)?(?:pan\.baidu\.com|pan\.quark\.cn|alipan\.com|aliyundrive\.com|cloud\.189\.cn|123pan\.com|115\.com|pan\.xunlei\.com|drive\.uc\.cn|(?:yun|caiyun)\.139\.com|mypikpak\.com|lanzou\w*\.com)(?:[/:]|$)[^\s<>"')\]]+$/i.test(url);
  };
  const linksOf = (value, hrefs) => {
    const links = [];
    const seen = new Set();
    const add = (raw) => {
      const url = String(raw || "").trim().replace(/[#\p{Extended_Pictographic}\uFE0F\u200D]+$/gu, "").replace(/[，。！？；：、）》】]+$/u, "");
      if (!isResource(url) || seen.has(url)) return;
      seen.add(url);
      links.push({ url, password: passwordOf(value) });
    };
    for (const url of String(value || "").match(/https?:\/\/[^\s<>"')\]]+/gi) || []) add(url);
    for (const url of hrefs || []) add(url);
    return links;
  };
  const output = [];
  if (context.format === "html" && $ && (context.route !== "jina" || /tgme_widget_message/.test(String(payload || "")))) {
    $(".tgme_widget_message_wrap").each((index, element) => {
      const root = $(element);
      const text = root.find(".tgme_widget_message_text").text().trim();
      const title = clean(text.split(/\n/)[0] || text).slice(0, 500);
      const content = clean(text);
      const hrefs = root.find(".tgme_widget_message_text a[href]").map((_, link) => $(link).attr("href") || "").get();
      const links = linksOf(text, hrefs);
      const postId = root.find(".tgme_widget_message").attr("data-post") || "";
      const datetime = root.find("time").attr("datetime") || "";
      if (matches(text) && links.length) output.push({ message_id: postId, unique_id: "tg-" + (context.channel || "channel") + "-" + (postId || index), channel: context.channel, datetime, title, content, links });
    });
  } else {
    const source = String(payload || "");
    const start = source.search(/^Markdown Content:\s*$/im);
    const content = start >= 0 ? source.slice(source.indexOf("\n", start) + 1) : source;
    const markers = [...content.matchAll(/\[\]\(\s*(https?:\/\/(?:www\.)?t\.me\/(?:s\/)?[^\s/)]+\/(\d+)(?:\?[^)]*)?)\s*\)/gi)];
    markers.forEach((marker, index) => {
      const markerText = marker[0];
      const blockStart = (marker.index || 0) + markerText.length;
      const blockEnd = markers[index + 1]?.index || content.length;
      const block = content.slice(blockStart, blockEnd).trim();
      const title = clean(block.split(/\n/).find((line) => line.trim()) || "").slice(0, 500);
      const hrefs = [...block.matchAll(/\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/gi)].map((item) => item[1]);
      const links = linksOf(block, hrefs);
      const postId = marker[2] || "";
      if (matches(block) && links.length) output.push({ message_id: postId, unique_id: "tg-" + (context.channel || "channel") + "-" + postId, channel: context.channel, title, content: clean(block), links });
    });
  }
  return output;
}`;

export interface TgSourceSettings {
  /** URL template; {{channel}} is path encoded, q/before are appended. */
  directTemplate: string;
  /** URL template for the reader/fallback route; {{channel}} is path encoded. */
  jinaTemplate: string;
  /** Legacy convenience field; copied into headers.user-agent. */
  userAgent: string;
  /** Additional request headers sent to both Telegram routes. */
  headers: Record<string, string>;
  /** Published transform source executed by the common parser runtime. */
  transform: string;
  /** Additional TG-compatible URL templates tried after directTemplate. */
  fallbackUrls: string[];
  /** Bounded retry policy applied independently to every TG endpoint. */
  retry: { maxRetries: number; delayMs: number };
  /** Configuration version exposed to parser results and diagnostics. */
  parserVersion: string;
}

const DEFAULTS: TgSourceSettings = {
  directTemplate: "https://t.me/s/{{channel}}",
  jinaTemplate: "https://r.jina.ai/https://t.me/s/{{channel}}",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  headers: {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  },
  transform: DEFAULT_TG_TRANSFORM,
  fallbackUrls: [],
  retry: { maxRetries: 0, delayMs: 250 },
  parserVersion: "1.0.0",
};
const MAX_TEMPLATE = 500;
const MAX_UA = 300;
const MAX_TRANSFORM = 100_000;
const MAX_FALLBACK_URLS = 8;
const MAX_HEADERS = 32;
const MAX_HEADER_VALUE = 1_000;
const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
]);

function sampleUrl(template: string): string {
  return template
    .replaceAll("{{channel}}", "demo_channel")
    .replaceAll("{{keyword}}", encodeURIComponent("demo"))
    .replaceAll("{{before}}", "123");
}

function sanitizeHeaders(
  raw: unknown,
  userAgent: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [rawName, rawValue] of Object.entries(
      raw as Record<string, unknown>,
    ).slice(0, MAX_HEADERS)) {
      const name = rawName.trim().toLowerCase();
      if (
        !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) ||
        FORBIDDEN_HEADERS.has(name)
      )
        continue;
      if (typeof rawValue !== "string") continue;
      headers[name] = rawValue.slice(0, MAX_HEADER_VALUE);
    }
  }
  headers["user-agent"] = headers["user-agent"] || userAgent;
  return headers;
}

function normalize(raw: unknown): TgSourceSettings {
  const value =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Partial<TgSourceSettings>)
      : {};
  const directTemplate = String(value.directTemplate || DEFAULTS.directTemplate)
    .trim()
    .slice(0, MAX_TEMPLATE);
  const jinaTemplate = String(value.jinaTemplate || DEFAULTS.jinaTemplate)
    .trim()
    .slice(0, MAX_TEMPLATE);
  const userAgent = String(value.userAgent || DEFAULTS.userAgent)
    .trim()
    .slice(0, MAX_UA);
  const transform = String(value.transform || DEFAULTS.transform)
    .trim()
    .slice(0, MAX_TRANSFORM);
  const fallbackUrls = Array.isArray(value.fallbackUrls)
    ? [...new Set(value.fallbackUrls
      .filter((url): url is string => typeof url === "string" && Boolean(url.trim()))
      .map((url) => url.trim().slice(0, MAX_TEMPLATE)))].slice(0, MAX_FALLBACK_URLS)
    : DEFAULTS.fallbackUrls;
  for (const [index, template] of fallbackUrls.entries()) {
    if (!template.includes("{{channel}}")) throw new Error(`fallbackUrls[${index}] 必须包含 {{channel}}`);
    validateOutboundUrl(sampleUrl(template), { allowHttp: false });
  }
  const rawRetry = value.retry && typeof value.retry === "object" && !Array.isArray(value.retry)
    ? value.retry as { maxRetries?: unknown; delayMs?: unknown }
    : {};
  const retry = {
    maxRetries: Number.isInteger(rawRetry.maxRetries) ? Math.min(3, Math.max(0, Number(rawRetry.maxRetries))) : DEFAULTS.retry.maxRetries,
    delayMs: Number.isInteger(rawRetry.delayMs) ? Math.min(5_000, Math.max(0, Number(rawRetry.delayMs))) : DEFAULTS.retry.delayMs,
  };
  const parserVersion = /^\d+\.\d+\.\d+$/.test(
    String(value.parserVersion || ""),
  )
    ? String(value.parserVersion)
    : DEFAULTS.parserVersion;
  for (const [name, template] of [
    ["directTemplate", directTemplate],
    ["jinaTemplate", jinaTemplate],
  ] as const) {
    if (!template.includes("{{channel}}"))
      throw new Error(`${name} 必须包含 {{channel}}`);
    validateOutboundUrl(sampleUrl(template), { allowHttp: false });
  }
  if (!transform) throw new Error("transform 不能为空");
  validateParserCode(transform);
  return {
    directTemplate,
    jinaTemplate,
    userAgent: userAgent || DEFAULTS.userAgent,
    headers: sanitizeHeaders(value.headers, userAgent || DEFAULTS.userAgent),
    transform,
    fallbackUrls,
    retry,
    parserVersion,
  };
}

export function getTgSourceSettings(): TgSourceSettings {
  const db = getSqliteDatabase();
  const row = db.getRow<any>("SELECT * FROM tg_source_settings WHERE id=1");
  if (row) {
    let headers: unknown = {}; let fallbackUrls: unknown = [];
    try { headers = JSON.parse(row.headers); } catch {}
    try { fallbackUrls = JSON.parse(row.fallback_urls); } catch {}
    return normalize({ directTemplate: row.direct_template, jinaTemplate: row.jina_template, userAgent: row.user_agent, headers, transform: row.transform, fallbackUrls, retry: { maxRetries: row.max_retries, delayMs: row.delay_ms }, parserVersion: row.parser_version });
  }
  const seeded = normalize(DEFAULTS);
  db.run("INSERT INTO tg_source_settings(id,direct_template,jina_template,user_agent,headers,transform,fallback_urls,max_retries,delay_ms,parser_version,updated_at) VALUES(1,?,?,?,?,?,?,?,?,?,?)", seeded.directTemplate, seeded.jinaTemplate, seeded.userAgent, JSON.stringify(seeded.headers), seeded.transform, JSON.stringify(seeded.fallbackUrls), seeded.retry.maxRetries, seeded.retry.delayMs, seeded.parserVersion, Date.now());
  return structuredClone(seeded);
}

function bumpParserVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return DEFAULTS.parserVersion;
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

export function saveTgSourceSettings(raw: unknown): TgSourceSettings {
  const current = getTgSourceSettings();
  const patch = raw && typeof raw === "object" ? raw as Partial<TgSourceSettings> : {};
  const transformChanged = typeof patch.transform === "string" && patch.transform.trim() !== current.transform;
  const next = normalize({
    ...current,
    ...patch,
    // Changing transform without an explicit version is still a new published
    // runtime. This makes hot updates visible in result provenance while
    // keeping old clients (which only submit the transform field) compatible.
    ...(transformChanged && patch.parserVersion === undefined
      ? { parserVersion: bumpParserVersion(current.parserVersion) }
      : {}),
  });
  const db = getSqliteDatabase();
  db.run("INSERT INTO tg_source_settings(id,direct_template,jina_template,user_agent,headers,transform,fallback_urls,max_retries,delay_ms,parser_version,updated_at) VALUES(1,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET direct_template=excluded.direct_template,jina_template=excluded.jina_template,user_agent=excluded.user_agent,headers=excluded.headers,transform=excluded.transform,fallback_urls=excluded.fallback_urls,max_retries=excluded.max_retries,delay_ms=excluded.delay_ms,parser_version=excluded.parser_version,updated_at=excluded.updated_at", next.directTemplate, next.jinaTemplate, next.userAgent, JSON.stringify(next.headers), next.transform, JSON.stringify(next.fallbackUrls), next.retry.maxRetries, next.retry.delayMs, next.parserVersion, Date.now());
  return structuredClone(next);
}

export function getTgTransform(): string {
  return getTgSourceSettings().transform;
}

export function saveTgTransform(transform: unknown): TgSourceSettings {
  if (typeof transform !== "string") throw new Error("transform 必须是 JavaScript 文本");
  return saveTgSourceSettings({ transform });
}

export function getTgSourceSettingsVersion(): string {
  const db = getSqliteDatabase();
  const value = getTgSourceSettings();
  return `${db.getRow<any>("SELECT updated_at FROM tg_source_settings WHERE id=1")?.updated_at ?? 0}:${JSON.stringify(value)}`;
}

export function buildConfiguredTgUrl(
  route: "direct" | "jina",
  channel: string,
  keyword: string,
  before?: string,
): string {
  return buildTgSourceUrl(
    route,
    channel,
    keyword,
    before,
    getTgSourceSettings(),
  );
}
