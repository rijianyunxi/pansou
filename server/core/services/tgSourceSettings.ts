import { getSqliteDatabase } from "../storage/sqlite";
import { validateOutboundUrl } from "../security/outboundUrl";
import { buildTgSourceUrl } from "../../../utils/tgSourceUrl";

export interface TgSourceSettings {
  /** URL template; {{channel}} is path encoded, q/before are appended. */
  directTemplate: string;
  /** URL template for the reader/fallback route; {{channel}} is path encoded. */
  jinaTemplate: string;
  /** Legacy convenience field; copied into headers.user-agent. */
  userAgent: string;
  /** Additional request headers sent to both Telegram routes. */
  headers: Record<string, string>;
  /** Additional TG-compatible URL templates tried after directTemplate. */
  fallbackUrls: string[];
  /** Bounded retry policy applied independently to every Telegram endpoint. */
  retry: { maxRetries: number; delayMs: number };
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
  fallbackUrls: [],
  retry: { maxRetries: 0, delayMs: 250 },
};
const MAX_TEMPLATE = 500;
const MAX_UA = 300;
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
  for (const [name, template] of [
    ["directTemplate", directTemplate],
    ["jinaTemplate", jinaTemplate],
  ] as const) {
    if (!template.includes("{{channel}}"))
      throw new Error(`${name} 必须包含 {{channel}}`);
    validateOutboundUrl(sampleUrl(template), { allowHttp: false });
  }
  return {
    directTemplate,
    jinaTemplate,
    userAgent: userAgent || DEFAULTS.userAgent,
    headers: sanitizeHeaders(value.headers, userAgent || DEFAULTS.userAgent),
    fallbackUrls,
    retry,
  };
}

export function getTgSourceSettings(): TgSourceSettings {
  const db = getSqliteDatabase();
  const row = db.getRow<any>("SELECT * FROM tg_source_settings WHERE id=1");
  if (row) {
    let headers: unknown = {}; let fallbackUrls: unknown = [];
    try { headers = JSON.parse(row.headers); } catch {}
    try { fallbackUrls = JSON.parse(row.fallback_urls); } catch {}
    return normalize({ directTemplate: row.direct_template, jinaTemplate: row.jina_template, userAgent: row.user_agent, headers, fallbackUrls, retry: { maxRetries: row.max_retries, delayMs: row.delay_ms } });
  }
  const seeded = normalize(DEFAULTS);
  db.run("INSERT INTO tg_source_settings(id,direct_template,jina_template,user_agent,headers,fallback_urls,max_retries,delay_ms,updated_at) VALUES(1,?,?,?,?,?,?,?,?)", seeded.directTemplate, seeded.jinaTemplate, seeded.userAgent, JSON.stringify(seeded.headers), JSON.stringify(seeded.fallbackUrls), seeded.retry.maxRetries, seeded.retry.delayMs, Date.now());
  return structuredClone(seeded);
}

export function saveTgSourceSettings(raw: unknown): TgSourceSettings {
  const current = getTgSourceSettings();
  const patch = raw && typeof raw === "object" ? raw as Partial<TgSourceSettings> : {};
  const next = normalize({ ...current, ...patch });
  const db = getSqliteDatabase();
  db.run("INSERT INTO tg_source_settings(id,direct_template,jina_template,user_agent,headers,fallback_urls,max_retries,delay_ms,updated_at) VALUES(1,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET direct_template=excluded.direct_template,jina_template=excluded.jina_template,user_agent=excluded.user_agent,headers=excluded.headers,fallback_urls=excluded.fallback_urls,max_retries=excluded.max_retries,delay_ms=excluded.delay_ms,updated_at=excluded.updated_at", next.directTemplate, next.jinaTemplate, next.userAgent, JSON.stringify(next.headers), JSON.stringify(next.fallbackUrls), next.retry.maxRetries, next.retry.delayMs, Date.now());
  return structuredClone(next);
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
