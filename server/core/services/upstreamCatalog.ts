import type { UpstreamDefinition } from "../../../types/source";
import { TG_CHANNEL_PATTERN, normalizeTelegramChannels } from "../../../utils/telegramChannels";
import { getSearchSettings, getSearchSettingsVersion, saveSearchSettings } from "./searchSettingsService";
import { getSystemSettings } from "./systemSettingsService";
import { getTgSourceSettings, getTgSourceSettingsVersion, buildConfiguredTgUrl } from "./tgSourceSettings";
import { getSqliteDatabase } from "../storage/sqlite";
import { validateOutboundUrl } from "../security/outboundUrl";
import { upstreamToSourceDefinition } from "./configuredSourcePlugin";
import { validateSourceDefinition, validateSourceTransformCode } from "../source-runtime/validation";
import { TELEGRAM_DEFAULT_TRANSFORM } from "../source-runtime/defaults";
import {
  clearTgChannelState,
  getTgChannelState,
  getTgChannelStates,
  getTgChannelSettingsVersion,
  setTgChannelState,
} from "./tgChannelSettings";

const ID_RE = /^[a-z0-9][a-z0-9_-]{1,79}$/;
const HTTP_ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
type StoredCatalog = Record<string, UpstreamDefinition>;

// The catalog accepts only the current request + transform model. Unknown
// properties are discarded by sanitizeSourceRequest instead of being carried
// through to the runtime.
function assertSourceObject(raw: unknown): asserts raw is Partial<UpstreamDefinition> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("来源配置必须是对象");
  }
}

function clone<T>(value: T): T { return structuredClone(value); }

function validateSourceUrl(url: string, sourceKind: "http" | "telegram"): void {
  const sample = sourceKind === "telegram"
    ? url.replaceAll("{{channel}}", "panhub_channel").replaceAll("{{keyword}}", encodeURIComponent("demo"))
    : url;
  validateOutboundUrl(sample, { allowHttp: false });
}

const REQUEST_FIELDS = [
  "query", "headers", "bodyType", "body",
  "maxResponseBytes", "redirect", "allowedDomains", "maxRequestBodyBytes",
] as const;

function sanitizeSourceRequest(raw: unknown): NonNullable<UpstreamDefinition["request"]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const request = raw as Record<string, unknown>;
  return Object.fromEntries(
    REQUEST_FIELDS
      .filter((field) => Object.prototype.hasOwnProperty.call(request, field))
      .map((field) => [field, structuredClone(request[field])]),
  ) as NonNullable<UpstreamDefinition["request"]>;
}

function telegramUrl(route: "direct" | "jina", channel: string): string {
  return buildConfiguredTgUrl(route, channel, "");
}

function systemDefaultChannels(): string[] {
  try {
    return normalizeTelegramChannels(getSystemSettings(useRuntimeConfig()).defaultChannels);
  } catch {
    return [];
  }
}

function isTelegramSource(value: Partial<UpstreamDefinition> | null | undefined): boolean {
  return value?.sourceKind === "telegram" || typeof value?.channel === "string" || String(value?.id || "").toLowerCase().startsWith("tg-");
}

function telegramId(channel: string): string {
  return `tg-${channel}`;
}

function sanitize(raw: unknown): StoredCatalog {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: StoredCatalog = {};
  for (const [rawId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const source = value as Partial<UpstreamDefinition>;
    const id = String(source.id || rawId).trim().toLowerCase();
    const sourceKind = source.sourceKind === "telegram" || typeof source.channel === "string" || id.startsWith("tg-") ? "telegram" : "http";
    const channel = sourceKind === "telegram"
      ? String(source.channel || id.slice(3)).trim().replace(/^@/, "").toLowerCase()
      : undefined;
    const url = String(source.url || "").trim();
    if (!ID_RE.test(id) || (sourceKind === "http" && !HTTP_ID_RE.test(id)) || !url) continue;
    if (sourceKind === "telegram" && (!channel || !TG_CHANNEL_PATTERN.test(channel))) continue;
    try { validateSourceUrl(url, sourceKind); } catch { continue; }
    const method = source.method === "POST" ? "POST" : source.method === "GET" ? "GET" : null;
    const format = source.format === "html" ? "html" : source.format === "json" ? "json" : null;
    if (!method || !format) continue;
    const transform = typeof source.transform === "string" ? source.transform.slice(0, 100_000) : "";
    if (!transform.trim()) continue;
    out[id] = {
      id,
      ...(sourceKind === "telegram" ? { sourceKind: "telegram" as const, channel } : { sourceKind: "http" as const }),
      name: String(source.name || id).trim().slice(0, 100),
      description: String(source.description || "").trim().slice(0, 500),
      url,
      method,
      format,
      transform,
      ...(source.request && typeof source.request === "object" && !Array.isArray(source.request)
        ? { request: sanitizeSourceRequest(source.request) }
        : {}),
      enabled: source.enabled !== false,
    };
  }
  return out;
}

function readPersistedCatalog(db: ReturnType<typeof getSqliteDatabase>): StoredCatalog {
  const rawCatalog: Record<string, unknown> = {};
  for (const row of db.allRows<any>("SELECT id,source_kind,channel,name,description,url,method,format,enabled,request_json,transform FROM upstream_definitions")) {
    let request: unknown;
    if (row.request_json) {
      try { request = JSON.parse(row.request_json); } catch { request = undefined; }
    }
    rawCatalog[row.id] = {
      id: row.id,
      sourceKind: row.source_kind,
      ...(row.channel ? { channel: row.channel } : {}),
      name: row.name,
      description: row.description,
      url: row.url,
      method: row.method,
      format: row.format,
      enabled: Boolean(row.enabled),
      transform: row.transform,
      ...(request && typeof request === "object" && !Array.isArray(request) ? { request } : {}),
    };
  }
  return sanitize(rawCatalog);
}

function readDeletedIds(db: ReturnType<typeof getSqliteDatabase>): Set<string> {
  return new Set(
    db.allRows<{ id: string }>("SELECT id FROM deleted_upstreams")
      .map((row) => String(row.id || "").trim().toLowerCase())
      .filter((id) => ID_RE.test(id)),
  );
}

function upsertCatalogEntry(db: ReturnType<typeof getSqliteDatabase>, definition: UpstreamDefinition, now = Date.now()): void {
  db.run(
    `INSERT INTO upstream_definitions(id,source_kind,channel,name,description,url,method,format,enabled,request_json,transform,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET source_kind=excluded.source_kind,channel=excluded.channel,name=excluded.name,description=excluded.description,url=excluded.url,method=excluded.method,format=excluded.format,enabled=excluded.enabled,request_json=excluded.request_json,transform=excluded.transform,updated_at=excluded.updated_at`,
    definition.id, definition.sourceKind, definition.channel ?? null, definition.name, definition.description,
    definition.url, definition.method, definition.format, definition.enabled === false ? 0 : 1,
    definition.request ? JSON.stringify(definition.request) : null, definition.transform, now,
  );
}

/** Full replacement is reserved for explicit imports/rebuilds, never ordinary edits. */
function replaceCatalog(db: ReturnType<typeof getSqliteDatabase>, catalog: StoredCatalog, now = Date.now()): void {
  const ids = Object.keys(catalog);
  if (ids.length) db.run(`DELETE FROM upstream_definitions WHERE id NOT IN (${ids.map(() => "?").join(",")})`, ...ids);
  else db.run("DELETE FROM upstream_definitions");
  for (const definition of Object.values(catalog)) upsertCatalogEntry(db, definition, now);
}

function writeDeletedIds(db: ReturnType<typeof getSqliteDatabase>, deleted: Set<string>, now = Date.now()): void {
  db.run("DELETE FROM deleted_upstreams");
  for (const id of deleted) db.run("INSERT INTO deleted_upstreams(id,deleted_at) VALUES(?,?)", id, now);
}

let catalogCache: { revision: number; catalog: StoredCatalog } | null = null;

function getCatalogRevision(db: ReturnType<typeof getSqliteDatabase>): number {
  return db.getRow<{ revision: number }>("SELECT revision FROM config_revisions WHERE scope='upstreams'")?.revision ?? 0;
}

function read(): StoredCatalog {
  const db = getSqliteDatabase();
  const revision = getCatalogRevision(db);
  if (catalogCache?.revision === revision) return catalogCache.catalog;
  const deleted = readDeletedIds(db);
  const existing = readPersistedCatalog(db);
  // 数据源目录完全由 SQLite 配置决定。deleted_upstreams 只记录已删除来源，
  // 绝不能触发任何内置来源的恢复或注入。
  const catalog = Object.fromEntries(
    Object.entries(existing).filter(([id]) => !deleted.has(id)),
  );
  catalogCache = { revision, catalog };
  return catalog;
}

export function listConfiguredUpstreams(): UpstreamDefinition[] {
  return Object.values(read())
    .filter((source) => source.sourceKind !== "telegram")
    .map(clone)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getConfiguredUpstream(id: string): UpstreamDefinition | undefined {
  const key = String(id || "").trim().toLowerCase();
  const source = read()[key];
  return source && source.sourceKind !== "telegram" ? clone(source) : undefined;
}

function buildTelegramDefinition(channel: string, stored?: UpstreamDefinition): UpstreamDefinition {
  const settings = getTgSourceSettings();
  const id = telegramId(channel);
  const state = getTgChannelState(channel);
  const source = {
    id,
    sourceKind: "telegram" as const,
    channel,
    name: stored?.name || `@${channel}`,
    description: stored?.description || "Telegram 频道来源",
    url: stored?.url || telegramUrl("direct", channel),
    method: "GET" as const,
    format: "html" as const,
    enabled: state ? state.enabled && !state.deleted : stored?.enabled !== false,
    request: stored?.request || {
      query: { q: "{{keyword}}" },
      headers: settings.headers,
    },
    transform: stored?.transform || TELEGRAM_DEFAULT_TRANSFORM,
  };
  const next = sanitize({ [id]: source })[id];
  if (!next) throw new Error(`Telegram channel configuration is invalid: ${channel}`);
  return next;
}

/** Unified management directory. Disabled TG rows remain visible so they can be edited or enabled again. */
export function listUnifiedUpstreams(): UpstreamDefinition[] {
  const catalog = read();
  const settings = getSearchSettings();
  const states = getTgChannelStates();
  const channels = new Set([
    ...systemDefaultChannels(),
    ...(settings.channels || []),
    ...Object.keys(states),
    ...Object.keys(catalog).filter((id) => id.startsWith("tg-")).map((id) => id.slice(3)),
  ]);
  const telegram = [...channels]
    .map((channel) => channel.replace(/^@/, "").toLowerCase())
    .filter((channel) => TG_CHANNEL_PATTERN.test(channel) && !states[channel]?.deleted)
    .map((channel) => buildTelegramDefinition(channel, catalog[telegramId(channel)]));
  // Listing is read-only. A default Telegram source is materialized only when
  // it is explicitly saved, preventing an innocent GET from writing SQLite.
  return [...listConfiguredUpstreams(), ...telegram].sort((a, b) => a.name.localeCompare(b.name));
}

export function getUnifiedUpstream(id: string): UpstreamDefinition | undefined {
  const key = String(id || "").trim().toLowerCase();
  const source = listUnifiedUpstreams().find((item) => item.id === key);
  if (source) return clone(source);
  // Disabled TG rows are intentionally omitted from the effective directory
  // list, but must remain addressable by the enable endpoint.
  const stored = read()[key];
  if (stored?.sourceKind === "telegram" && stored.channel) {
    return clone(buildTelegramDefinition(stored.channel, stored));
  }
  return undefined;
}

/** Validate and normalize an unsaved source for the admin online debugger without persisting it. */
export function prepareUnifiedUpstreamForProbe(raw: unknown): UpstreamDefinition {
  assertSourceObject(raw);
  const value = structuredClone(raw);
  const telegram = isTelegramSource(value);
  const channel = telegram
    ? String(value.channel || "").trim().replace(/^@/, "").toLowerCase()
    : "";
  if (telegram && !TG_CHANNEL_PATTERN.test(channel)) {
    throw new Error("Telegram 来源必须填写有效的公开频道用户名");
  }
  const id = String(value.id || (telegram ? telegramId(channel) : "debug-draft"))
    .trim()
    .toLowerCase();
  const input = telegram
    ? { ...buildTelegramDefinition(channel), ...value, id, sourceKind: "telegram" as const, channel }
    : { ...value, id, sourceKind: "http" as const };
  const next = sanitize({ [id]: input })[id];
  if (!next) throw new Error("来源配置无效：请检查 HTTPS 地址、请求方式、响应格式和 transform");
  validateSourceTransformCode(next.transform);

  validateSourceDefinition(upstreamToSourceDefinition(next));
  return clone(next);
}

export function saveConfiguredUpstream(raw: unknown): UpstreamDefinition {
  assertSourceObject(raw);
  const value = raw;
  const id = String(value.id || "").trim().toLowerCase();
  const catalog = read();
  const current = catalog[id];
  const merged = { ...current, ...value, id } as Partial<UpstreamDefinition>;
  const next = sanitize({ [id]: merged })[id];
  if (!next) throw new Error("来源配置无效：请检查 ID、HTTPS 地址、请求方式、响应格式和 transform");
  validateSourceTransformCode(next.transform);

  validateSourceDefinition(upstreamToSourceDefinition(next));
  const store = getSqliteDatabase();
  const deleted = readDeletedIds(store);
  store.transaction(() => {
    if (deleted.delete(id)) store.run("DELETE FROM deleted_upstreams WHERE id=?", id);
    upsertCatalogEntry(store, next);
  });
  return clone(next);
}

export function saveConfiguredTelegramUpstream(raw: unknown): UpstreamDefinition {
  assertSourceObject(raw);
  const value = raw;
  const rawChannel = String(value.channel || (String(value.id || "").toLowerCase().startsWith("tg-") ? String(value.id).slice(3) : ""));
  const channel = rawChannel.trim().replace(/^@/, "").toLowerCase();
  if (!TG_CHANNEL_PATTERN.test(channel)) throw new Error("Telegram 来源必须填写有效的公开频道用户名");
  const catalog = read();
  const id = telegramId(channel);
  const current = catalog[id];
  const nextInput = {
    ...buildTelegramDefinition(channel, current),
    ...value,
    id,
    sourceKind: "telegram" as const,
    channel,
    method: value.method || "GET",
    format: value.format || "html",
    url: value.url || current?.url || telegramUrl("direct", channel),
    request: value.request !== undefined ? value.request : current?.request || { headers: getTgSourceSettings().headers, query: { q: "{{keyword}}" } },
    transform: value.transform !== undefined ? value.transform : current?.transform || TELEGRAM_DEFAULT_TRANSFORM,
  };
  const next = sanitize({ [id]: nextInput })[id];
  if (!next) throw new Error("Telegram 来源配置无效：请检查频道、HTTPS 地址、请求配置和响应格式");
  validateSourceTransformCode(next.transform);
  validateSourceDefinition(upstreamToSourceDefinition(next));
  const settings = getSearchSettings();
  const configured = settings.channels === null ? systemDefaultChannels() : settings.channels;
  if (!configured.includes(channel)) saveSearchSettings({ channels: [...configured, channel] });
  clearTgChannelState(channel);
  const db = getSqliteDatabase();
  db.transaction(() => upsertCatalogEntry(db, next));
  return clone(next);
}

export function saveUnifiedUpstream(raw: unknown): UpstreamDefinition {
  assertSourceObject(raw);
  return isTelegramSource(raw) ? saveConfiguredTelegramUpstream(raw) : saveConfiguredUpstream(raw);
}

export function deleteConfiguredTelegramUpstream(idOrChannel: string): void {
  const raw = String(idOrChannel || "").trim().toLowerCase();
  const channel = raw.startsWith("tg-") ? raw.slice(3) : raw.replace(/^@/, "");
  if (!TG_CHANNEL_PATTERN.test(channel)) throw new Error("Unknown Telegram upstream");
  const settings = getSearchSettings();
  const defaults = systemDefaultChannels();
  const catalog = read();
  if (settings.channels?.includes(channel)) {
    saveSearchSettings({ channels: settings.channels.filter((item) => item !== channel) });
    clearTgChannelState(channel);
  } else if (defaults.includes(channel)) {
    setTgChannelState(channel, { deleted: true });
  } else {
    throw new Error("Unknown Telegram upstream");
  }
  if (catalog[telegramId(channel)]) {
    getSqliteDatabase().run("DELETE FROM upstream_definitions WHERE id=?", telegramId(channel));
  }
}

export function deleteUnifiedUpstream(id: string): void {
  const source = getUnifiedUpstream(id);
  if (!source) throw new Error("Unknown upstream");
  if (source.sourceKind === "telegram") return deleteConfiguredTelegramUpstream(source.id);
  return deleteConfiguredUpstream(source.id);
}

export function setUnifiedUpstreamEnabled(id: string, enabled: boolean): UpstreamDefinition {
  const source = getUnifiedUpstream(id);
  if (!source) throw new Error("Unknown upstream");
  if (source.sourceKind === "telegram" && source.channel) {
    const state = setTgChannelState(source.channel, { enabled, deleted: false });
    const current = read()[source.id] || source;
    const next = { ...current, enabled: state.enabled && !state.deleted };
    const db = getSqliteDatabase();
    db.transaction(() => upsertCatalogEntry(db, next));
    return clone(buildTelegramDefinition(source.channel, next));
  }
  return setConfiguredUpstreamEnabled(source.id, enabled);
}

export function deleteConfiguredUpstream(id: string): void {
  const key = String(id || "").trim().toLowerCase();
  const store = getSqliteDatabase();
  if (!read()[key]) throw new Error("Unknown upstream");
  store.transaction(() => {
    store.run("DELETE FROM upstream_definitions WHERE id=?", key);
    store.run("INSERT INTO deleted_upstreams(id,deleted_at) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET deleted_at=excluded.deleted_at", key, Date.now());
  });
}

export function setConfiguredUpstreamEnabled(id: string, enabled: boolean): UpstreamDefinition {
  const key = String(id || "").trim().toLowerCase();
  const current = read()[key];
  if (!current) throw new Error("Unknown upstream");
  const next = { ...current, enabled: !!enabled };
  const db = getSqliteDatabase();
  db.transaction(() => upsertCatalogEntry(db, next));
  return clone(next);
}

export function getConfiguredUpstreamVersion(): string {
  const db = getSqliteDatabase();
  return String(getCatalogRevision(db));
}


export function getUnifiedUpstreamVersion(): string {
  return `${getConfiguredUpstreamVersion()}|${getSearchSettingsVersion()}|${getTgChannelSettingsVersion()}|${getTgSourceSettingsVersion()}`;
}

export const UPSTREAM_CONFIG_SCHEMA_VERSION = 3;

export interface UpstreamConfigExport {
  schemaVersion: number;
  exportedAt: string;
  upstreams: UpstreamDefinition[];
}

/** Stable JSON-compatible payload used by both JSON and generated JS exports. */
export function exportConfiguredUpstreams(): UpstreamConfigExport {
  return {
    schemaVersion: UPSTREAM_CONFIG_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    upstreams: listUnifiedUpstreams(),
  };
}

/**
 * Accept JSON exports and the generated `export default {...};` JS file format.
 * No arbitrary JavaScript is evaluated; the JS wrapper contains JSON only.
 */
export function parseUpstreamConfigExport(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const text = raw.trim();
  const moduleMatch = /^export\s+default\s+([\s\S]*?);?\s*$/.exec(text);
  const json = moduleMatch ? moduleMatch[1]!.trim() : text;
  try {
    return JSON.parse(json);
  } catch {
    throw new Error("来源配置文件必须是 JSON 或由系统导出的 JS 文件");
  }
}

export function importConfiguredUpstreams(raw: unknown, actor = "admin"): UpstreamDefinition[] {
  const payload = parseUpstreamConfigExport(raw);
  const entries = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { upstreams?: unknown }).upstreams)
      ? (payload as { upstreams: unknown[] }).upstreams
      : [];
  if (!entries.length || entries.length > 100) throw new Error("upstreams 必须包含 1-100 个配置");

  const catalog = read();
  const nextCatalog = { ...catalog };
  const imported: UpstreamDefinition[] = [];
  for (const entry of entries) {
    assertSourceObject(entry);
    const value = entry;
    const id = String(value.id || "").trim().toLowerCase();
    if (isTelegramSource(value)) {
      const saved = saveConfiguredTelegramUpstream(value);
      nextCatalog[saved.id] = saved;
      imported.push(saved);
      continue;
    }
    const next = sanitize({ [id]: { ...catalog[id], ...value, id } })[id];
    if (!next) throw new Error(`来源配置无效: ${id || "缺少 id"}`);
    validateSourceTransformCode(next.transform);
    validateSourceDefinition(upstreamToSourceDefinition(next));
    nextCatalog[id] = next;
    imported.push(clone(next));
  }
  const store = getSqliteDatabase();
  const deleted = readDeletedIds(store);
  for (const source of imported) deleted.delete(source.id);
  store.transaction(() => {
    replaceCatalog(store, nextCatalog);
    writeDeletedIds(store, deleted);
  });
  void actor;
  return imported;
}
