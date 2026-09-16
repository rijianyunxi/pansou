import { getSqliteDatabase } from "../storage/sqlite";
import { validateOutboundUrl } from "../security/outboundUrl";
import { validateSourceTransformCode } from "../source-runtime/validation";
import { DEFAULT_CHANNEL_TRANSFORM } from "../source-runtime/defaults";

export interface SourceTemplateSettings {
  urlTemplate: string;
  method: "GET" | "POST";
  format: "json" | "html";
  request: Record<string, unknown>;
  transform: string;
}

const DEFAULTS: SourceTemplateSettings = {
  urlTemplate: "https://t.me/s/{{channel}}",
  method: "GET",
  format: "html",
  request: { query: { q: "{{keyword}}" }, headers: { "user-agent": "Mozilla/5.0" } },
  transform: DEFAULT_CHANNEL_TRANSFORM,
};

function normalize(raw: unknown): SourceTemplateSettings {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Partial<SourceTemplateSettings> : {};
  const urlTemplate = String(value.urlTemplate || DEFAULTS.urlTemplate).trim();
  if (!urlTemplate.includes("{{channel}}")) throw new Error("来源模板 URL 必须包含 {{channel}}");
  validateOutboundUrl(urlTemplate.replaceAll("{{channel}}", "panhub_channel"), { allowHttp: false });
  const method = value.method === "POST" ? "POST" : "GET";
  const format = value.format === "json" ? "json" : "html";
  const request = value.request && typeof value.request === "object" && !Array.isArray(value.request)
    ? structuredClone(value.request as Record<string, unknown>) : structuredClone(DEFAULTS.request);
  const transform = String(value.transform || DEFAULTS.transform).trim();
  validateSourceTransformCode(transform);
  return { urlTemplate, method, format, request, transform };
}

export function getSourceTemplateSettings(): SourceTemplateSettings {
  const db = getSqliteDatabase();
  const row = db.getRow<any>("SELECT url_template,method,format,request_json,transform FROM source_template_settings WHERE id=1");
  if (!row) {
    const seeded = normalize(DEFAULTS);
    db.run("INSERT INTO source_template_settings(id,url_template,method,format,request_json,transform,updated_at) VALUES(1,?,?,?,?,?,?)", seeded.urlTemplate, seeded.method, seeded.format, JSON.stringify(seeded.request), seeded.transform, Date.now());
    return structuredClone(seeded);
  }
  let request: unknown = {};
  try { request = JSON.parse(row.request_json || "{}"); } catch { request = {}; }
  return normalize({ urlTemplate: row.url_template, method: row.method, format: row.format, request, transform: row.transform });
}

export function saveSourceTemplateSettings(raw: unknown): SourceTemplateSettings {
  const current = getSourceTemplateSettings();
  const patch = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Partial<SourceTemplateSettings> : {};
  const next = normalize({ ...current, ...patch });
  getSqliteDatabase().run("INSERT INTO source_template_settings(id,url_template,method,format,request_json,transform,updated_at) VALUES(1,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET url_template=excluded.url_template,method=excluded.method,format=excluded.format,request_json=excluded.request_json,transform=excluded.transform,updated_at=excluded.updated_at", next.urlTemplate, next.method, next.format, JSON.stringify(next.request), next.transform, Date.now());
  return structuredClone(next);
}

export function getSourceTemplateVersion(): string {
  const db = getSqliteDatabase();
  const row = db.getRow<{ updated_at: number }>("SELECT updated_at FROM source_template_settings WHERE id=1");
  return String(row?.updated_at || 0);
}

function replaceChannel(value: unknown, channel: string): unknown {
  if (typeof value === "string") return value.replaceAll("{{channel}}", channel);
  if (Array.isArray(value)) return value.map((item) => replaceChannel(item, channel));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, replaceChannel(child, channel)]));
  }
  return value;
}

export function buildSourceFromTemplate(channel: string): SourceTemplateSettings & { url: string } {
  const settings = getSourceTemplateSettings();
  const normalized = channel.trim().replace(/^@/, "").toLowerCase();
  const encoded = encodeURIComponent(normalized);
  const url = settings.urlTemplate.replaceAll("{{channel}}", encoded);
  const request = replaceChannel(structuredClone(settings.request), normalized) as Record<string, unknown>;
  return { ...settings, url, request };
}
