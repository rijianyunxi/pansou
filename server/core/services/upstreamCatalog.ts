import type { UpstreamDefinition } from "../../../types/source";
import { TG_CHANNEL_PATTERN, normalizeTelegramChannels } from "../../../utils/telegramChannels";
import { getSearchSettings, getSearchSettingsVersion, saveSearchSettings } from "./searchSettingsService";
import { getSystemSettings } from "./systemSettingsService";
import { getSqliteDatabase } from "../storage/sqlite";
import { validateOutboundUrl } from "../security/outboundUrl";
import { upstreamToSourceDefinition, getSourceConfigurationVersion } from "./configuredSource";
import { validateSourceDefinition, validateSourceTransformCode } from "../source-runtime/validation";
import { buildSourceFromTemplate, getSourceTemplateSettings, getSourceTemplateVersion } from "./sourceTemplateSettings";
import { getTgChannelStates, setTgChannelState, clearTgChannelState } from "./tgChannelSettings";

const ID_RE = /^[a-z0-9][a-z0-9_-]{1,79}$/;
type StoredCatalog = Record<string, UpstreamDefinition>;

function clone<T>(value: T): T { return structuredClone(value); }
function assertSourceObject(raw: unknown): asserts raw is Partial<UpstreamDefinition> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("来源配置必须是对象");
}
function validateSourceUrl(url: string): void {
  const sample = url.replaceAll("{{keyword}}", encodeURIComponent("demo")).replaceAll("{{channel}}", "panhub_channel");
  validateOutboundUrl(sample, { allowHttp: false });
}
const REQUEST_FIELDS = ["query", "headers", "bodyType", "body", "maxResponseBytes", "redirect", "allowedDomains", "maxRequestBodyBytes"] as const;
function sanitizeSourceRequest(raw: unknown): NonNullable<UpstreamDefinition["request"]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const value = raw as Record<string, unknown>;
  return Object.fromEntries(REQUEST_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(value, field)).map((field) => [field, structuredClone(value[field])])) as NonNullable<UpstreamDefinition["request"]>;
}
function normalizeId(value: unknown): string { return String(value || "").trim().toLowerCase(); }
function normalizePriority(value: unknown): number {
  const priority = Number(value);
  if (!Number.isFinite(priority)) return 0;
  return Math.max(0, Math.min(999, Math.trunc(priority)));
}
function normalizeChannel(value: unknown): string { return String(value || "").trim().replace(/^@/, "").toLowerCase(); }
function configuredChannels(): string[] {
  const settings = getSearchSettings();
  const system = getSystemSettings(useRuntimeConfig());
  return normalizeTelegramChannels(settings.channels ?? system.defaultChannels).filter((channel) => TG_CHANNEL_PATTERN.test(channel));
}
function sanitize(raw: unknown): StoredCatalog {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: StoredCatalog = {};
  for (const [rawId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const source = value as Partial<UpstreamDefinition>;
    const id = normalizeId(source.id || rawId);
    const url = String(source.url || "").trim();
    const method = source.method === "POST" ? "POST" : source.method === "GET" ? "GET" : null;
    const format = source.format === "html" ? "html" : source.format === "json" ? "json" : null;
    const transform = typeof source.transform === "string" ? source.transform.slice(0, 100_000) : "";
    if (!ID_RE.test(id) || !url || !method || !format || !transform.trim()) continue;
    try { validateSourceUrl(url); } catch { continue; }
    out[id] = {
      id,
      name: String(source.name || id).trim().slice(0, 100),
      description: String(source.description || "").trim().slice(0, 500),
      url, method, format, transform,
      priority: normalizePriority(source.priority),
      enabled: source.enabled !== false,
      request: sanitizeSourceRequest(source.request),
    };
  }
  return out;
}
function read(): StoredCatalog {
  const db = getSqliteDatabase();
  const deletedSourceIds = new Set(
    db.allRows<{ id: string }>("SELECT id FROM deleted_sources").map((row) => row.id),
  );
  const tgStates = getTgChannelStates();
  const rows = db.allRows<any>("SELECT id,name,description,url,method,format,priority,enabled,request_json,transform FROM resource_sources");
  const raw: Record<string, unknown> = {};
  for (const row of rows) {
    const id = normalizeId(row.id);
    // Telegram channels are persisted as normal resource sources, while their
    // recycle-bin state is kept in tg_channel_states. Never expose an archived
    // row through the active source catalog.
    if (deletedSourceIds.has(id) || (TG_CHANNEL_PATTERN.test(id) && tgStates[id]?.deleted)) continue;
    let request: unknown = {};
    try { request = JSON.parse(row.request_json || "{}"); } catch { request = {}; }
    raw[id] = { ...row, id, request, enabled: Boolean(row.enabled) };
  }
  return sanitize(raw);
}
function writeSource(source: UpstreamDefinition): void {
  const db = getSqliteDatabase();
  db.run("INSERT INTO resource_sources(id,name,description,url,method,format,priority,enabled,request_json,transform,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,url=excluded.url,method=excluded.method,format=excluded.format,priority=excluded.priority,enabled=excluded.enabled,request_json=excluded.request_json,transform=excluded.transform,updated_at=excluded.updated_at", source.id, source.name, source.description, source.url, source.method, source.format, source.priority ?? 0, source.enabled === false ? 0 : 1, source.request ? JSON.stringify(source.request) : null, source.transform, Date.now());
}
export function buildUserSource(channel: string): UpstreamDefinition {
  const normalized = normalizeChannel(channel);
  const template = buildSourceFromTemplate(normalized);
  return {
    id: normalized,
    name: `@${normalized}`,
    description: "系统模板来源",
    url: template.url,
    method: template.method,
    format: template.format,
    priority: 0,
    enabled: true,
    request: template.request as UpstreamDefinition["request"],
    transform: template.transform,
  };
}
function effectiveSource(id: string, catalog: StoredCatalog): UpstreamDefinition | undefined {
  const key = normalizeId(id);
  if (getTgChannelStates()[key]?.deleted) return undefined;
  const direct = catalog[key];
  if (direct) return clone(direct);
  if (TG_CHANNEL_PATTERN.test(key) && configuredChannels().includes(key)) return buildUserSource(key);
  return undefined;
}

function compareSources(a: UpstreamDefinition, b: UpstreamDefinition): number {
  return (b.priority ?? 0) - (a.priority ?? 0)
    || a.name.localeCompare(b.name)
    || a.id.localeCompare(b.id);
}

export function listConfiguredUpstreams(): UpstreamDefinition[] {
  return Object.values(read()).sort(compareSources);
}
export function getConfiguredUpstream(id: string): UpstreamDefinition | undefined { return read()[normalizeId(id)] && clone(read()[normalizeId(id)]); }
export function listUnifiedUpstreams(): UpstreamDefinition[] {
  const catalog = read();
  const channels = new Set(configuredChannels());
  const states = getTgChannelStates();
  for (const channel of channels) {
    if (!catalog[channel] && !states[channel]?.deleted) catalog[channel] = buildUserSource(channel);
    if (catalog[channel] && states[channel]) catalog[channel]!.enabled = states[channel]!.enabled && !states[channel]!.deleted;
  }
  return Object.values(catalog).sort(compareSources).map(clone);
}
export function getUnifiedUpstream(id: string): UpstreamDefinition | undefined { return effectiveSource(id, read()); }
export function saveUnifiedUpstream(raw: unknown): UpstreamDefinition {
  assertSourceObject(raw);
  const id = normalizeId(raw.id);
  const next = sanitize({ [id]: { ...raw, id } })[id];
  if (!next) throw new Error("来源配置无效：请检查 ID、HTTPS 地址、请求方式、响应格式和 transform");
  validateSourceTransformCode(next.transform);
  validateSourceDefinition(upstreamToSourceDefinition(next));
  writeSource(next);
  return clone(next);
}
export function deleteUnifiedUpstream(id: string): void {
  const key = normalizeId(id);
  const source = getUnifiedUpstream(key);
  if (!source) throw new Error("Unknown source");

  // Telegram sources use the same catalog but retain their lifecycle state in
  // tg_channel_states so a generated template source does not get persisted as
  // a duplicate resource_sources row.
  if (TG_CHANNEL_PATTERN.test(key)) {
    const settings = getSearchSettings();
    const system = getSystemSettings(useRuntimeConfig());
    if (settings.channels?.includes(key)) {
      saveSearchSettings({ channels: settings.channels.filter((channel) => channel !== key) });
      clearTgChannelState(key);
      return;
    }
    if (normalizeTelegramChannels(system.defaultChannels).includes(key)) {
      setTgChannelState(key, { deleted: true });
      return;
    }
  }

  const db = getSqliteDatabase();
  db.transaction(() => {
    db.run("DELETE FROM resource_sources WHERE id=?", key);
    db.run("INSERT INTO deleted_sources(id,deleted_at) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET deleted_at=excluded.deleted_at", key, Date.now());
  });
}
export function setUnifiedUpstreamEnabled(id: string, enabled: boolean): UpstreamDefinition {
  const key = normalizeId(id);
  let source = getUnifiedUpstream(key);

  // A deleted built-in Telegram source is intentionally absent from the active
  // catalog. Rehydrate its template so the same resource-source endpoint can
  // restore it without introducing a second channel-specific monitor path.
  if (!source && TG_CHANNEL_PATTERN.test(key) && configuredChannels().includes(key)) {
    source = buildUserSource(key);
  }
  if (!source) throw new Error("Unknown source");

  const next = { ...source, enabled: !!enabled };
  if (TG_CHANNEL_PATTERN.test(key)) {
    setTgChannelState(key, { enabled: !!enabled, deleted: false });
    // A Telegram source may also have an explicitly persisted custom
    // definition. Keep that row's enabled flag in sync when it exists.
    if (getConfiguredUpstream(key)) writeSource(next);
    return clone(next);
  }
  writeSource(next);
  return clone(next);
}
export function getConfiguredUpstreamVersion(): string { return String(getSqliteDatabase().getRow<any>("SELECT revision FROM config_revisions WHERE scope='sources'")?.revision || 0); }
export function getUnifiedUpstreamVersion(): string { return `${getConfiguredUpstreamVersion()}|${getSearchSettingsVersion()}|${getSourceTemplateVersion()}`; }
export const UPSTREAM_CONFIG_SCHEMA_VERSION = 5;
export interface UpstreamConfigExport { schemaVersion: number; exportedAt: string; upstreams: UpstreamDefinition[]; }
export function exportConfiguredUpstreams(): UpstreamConfigExport { return { schemaVersion: UPSTREAM_CONFIG_SCHEMA_VERSION, exportedAt: new Date().toISOString(), upstreams: listUnifiedUpstreams() }; }
export function parseUpstreamConfigExport(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const text = raw.trim();
  const match = /^export\s+default\s+([\s\S]*?);?\s*$/.exec(text);
  try { return JSON.parse(match ? match[1]!.trim() : text); } catch { throw new Error("来源配置文件必须是 JSON 或由系统导出的 JS 文件"); }
}
export function importConfiguredUpstreams(raw: unknown, actor = "admin"): UpstreamDefinition[] {
  const payload = parseUpstreamConfigExport(raw);
  const entries = Array.isArray(payload) ? payload : payload && typeof payload === "object" && Array.isArray((payload as any).upstreams) ? (payload as any).upstreams : [];
  if (!entries.length || entries.length > 100) throw new Error("upstreams 必须包含 1-100 个配置");
  const imported = entries.map((entry: unknown) => saveUnifiedUpstream(entry));
  void actor;
  return imported;
}

// Channel management uses the same source catalog. These names remain local to
// the channel-management APIs; the search runtime only sees ResourceSource.
export function saveConfiguredTelegramUpstream(raw: unknown): UpstreamDefinition { return saveUnifiedUpstream(raw); }
export function deleteConfiguredTelegramUpstream(idOrChannel: string): void {
  const channel = normalizeChannel(idOrChannel);
  const settings = getSearchSettings();
  if (settings.channels) saveSearchSettings({ channels: settings.channels.filter((item) => item !== channel) });
  clearTgChannelState(channel);
  if (getConfiguredUpstream(channel)) deleteUnifiedUpstream(channel);
}
