import type { SourceDefinition } from "../../../types/source";
import { CHANNEL_NAME_PATTERN, normalizeChannelNames } from "../../../utils/customChannels";
import { getSearchSettings, getSearchSettingsVersion, saveSearchSettings } from "./searchSettingsService";
import { getSystemSettings } from "./systemSettingsService";
import { getSqliteDatabase } from "../storage/sqlite";
import { validateOutboundUrl } from "../security/outboundUrl";
import { toSourceDefinition, getSourceConfigurationVersion } from "./configuredSource";
import { validateSourceDefinition, validateSourceTransformCode } from "../source-runtime/validation";
import { buildSourceFromTemplate, getSourceTemplateSettings, getSourceTemplateVersion } from "./sourceTemplateSettings";
import { getSourceLifecycleStates, setSourceLifecycleState, clearSourceLifecycleState } from "./sourceLifecycleStore";

const ID_RE = /^[a-z0-9][a-z0-9_-]{1,79}$/;
type StoredCatalog = Record<string, SourceDefinition>;

function clone<T>(value: T): T { return structuredClone(value); }
function assertSourceObject(raw: unknown): asserts raw is Partial<SourceDefinition> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("来源配置必须是对象");
}
function validateSourceUrl(url: string): void {
  const sample = url.replaceAll("{{keyword}}", encodeURIComponent("demo")).replaceAll("{{channel}}", "panhub_channel");
  validateOutboundUrl(sample, { allowHttp: false });
}
const REQUEST_FIELDS = ["query", "headers", "bodyType", "body", "maxResponseBytes", "redirect", "allowedDomains", "maxRequestBodyBytes"] as const;
function sanitizeSourceRequest(raw: unknown): NonNullable<SourceDefinition["request"]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const value = raw as Record<string, unknown>;
  return Object.fromEntries(REQUEST_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(value, field)).map((field) => [field, structuredClone(value[field])])) as NonNullable<SourceDefinition["request"]>;
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
  return normalizeChannelNames(settings.channels ?? system.defaultChannels).filter((channel) => CHANNEL_NAME_PATTERN.test(channel));
}
/**
 * Channel-backed sources share one id space with regular sources, so a
 * channel-shaped id only counts as a channel source when a configured channel
 * list or a persisted lifecycle override claims it. Without this gate a regular
 * source whose id happens to look like a username would take the channel path.
 */
function isChannelSourceId(id: string): boolean {
  return CHANNEL_NAME_PATTERN.test(id)
    && (configuredChannels().includes(id) || getSourceLifecycleStates()[id] !== undefined);
}
function sanitize(raw: unknown): StoredCatalog {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: StoredCatalog = {};
  for (const [rawId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const source = value as Partial<SourceDefinition>;
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
  const lifecycleStates = getSourceLifecycleStates();
  const rows = db.allRows<any>("SELECT id,name,description,url,method,format,priority,enabled,request_json,transform FROM resource_sources");
  const raw: Record<string, unknown> = {};
  for (const row of rows) {
    const id = normalizeId(row.id);
    // Channel sources are persisted as normal resource sources, while their
    // recycle-bin state is kept in source_lifecycle_states. Never expose an
    // archived row through the active source catalog.
    if (deletedSourceIds.has(id) || (CHANNEL_NAME_PATTERN.test(id) && lifecycleStates[id]?.deleted)) continue;
    let request: unknown = {};
    try { request = JSON.parse(row.request_json || "{}"); } catch { request = {}; }
    raw[id] = { ...row, id, request, enabled: Boolean(row.enabled) };
  }
  return sanitize(raw);
}
function writeSource(source: SourceDefinition): void {
  const db = getSqliteDatabase();
  db.run("INSERT INTO resource_sources(id,name,description,url,method,format,priority,enabled,request_json,transform,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,url=excluded.url,method=excluded.method,format=excluded.format,priority=excluded.priority,enabled=excluded.enabled,request_json=excluded.request_json,transform=excluded.transform,updated_at=excluded.updated_at", source.id, source.name, source.description, source.url, source.method, source.format, source.priority ?? 0, source.enabled === false ? 0 : 1, source.request ? JSON.stringify(source.request) : null, source.transform, Date.now());
}
export function buildUserSource(channel: string): SourceDefinition {
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
    request: template.request as SourceDefinition["request"],
    transform: template.transform,
  };
}
function effectiveSource(id: string, catalog: StoredCatalog): SourceDefinition | undefined {
  const key = normalizeId(id);
  if (getSourceLifecycleStates()[key]?.deleted) return undefined;
  const direct = catalog[key];
  if (direct) return clone(direct);
  if (CHANNEL_NAME_PATTERN.test(key) && configuredChannels().includes(key)) return buildUserSource(key);
  return undefined;
}

/** Queue position, not a rank: a smaller priority starts earlier. Ties fall back to name, then id. */
function compareSources(a: SourceDefinition, b: SourceDefinition): number {
  return (a.priority ?? 0) - (b.priority ?? 0)
    || a.name.localeCompare(b.name)
    || a.id.localeCompare(b.id);
}

export function listConfiguredSources(): SourceDefinition[] {
  return Object.values(read()).sort(compareSources);
}
export function getConfiguredSource(id: string): SourceDefinition | undefined { return read()[normalizeId(id)] && clone(read()[normalizeId(id)]); }
export function listUnifiedSources(): SourceDefinition[] {
  const catalog = read();
  const channels = new Set(configuredChannels());
  const states = getSourceLifecycleStates();
  for (const channel of channels) {
    if (!catalog[channel] && !states[channel]?.deleted) catalog[channel] = buildUserSource(channel);
    if (catalog[channel] && states[channel]) catalog[channel]!.enabled = states[channel]!.enabled && !states[channel]!.deleted;
  }
  return Object.values(catalog).sort(compareSources).map(clone);
}
export function getUnifiedSource(id: string): SourceDefinition | undefined { return effectiveSource(id, read()); }
function prepareUnifiedSource(raw: unknown, index?: number): SourceDefinition {
  try {
    assertSourceObject(raw);
    const id = normalizeId(raw.id);
    const next = sanitize({ [id]: { ...raw, id } })[id];
    if (!next) throw new Error("请检查 ID、HTTPS 地址、请求方式、响应格式和 transform");
    validateSourceTransformCode(next.transform);
    validateSourceDefinition(toSourceDefinition(next));
    return clone(next);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (index === undefined) throw new Error(`来源配置无效：${message}`);
    throw new Error(`第 ${index + 1} 条来源配置无效：${message}`);
  }
}

export function saveUnifiedSource(raw: unknown): SourceDefinition {
  const next = prepareUnifiedSource(raw);
  writeSource(next);
  return clone(next);
}
export function deleteUnifiedSource(id: string): void {
  const key = normalizeId(id);
  const source = getUnifiedSource(key);
  if (!source) throw new Error("Unknown source");

  // Channel sources use the same catalog but retain their lifecycle state in
  // source_lifecycle_states so a generated template source does not get
  // persisted as a duplicate resource_sources row.
  if (isChannelSourceId(key)) {
    const settings = getSearchSettings();
    const system = getSystemSettings(useRuntimeConfig());
    if (settings.channels?.includes(key)) {
      saveSearchSettings({ channels: settings.channels.filter((channel) => channel !== key) });
      clearSourceLifecycleState(key);
      return;
    }
    if (normalizeChannelNames(system.defaultChannels).includes(key)) {
      setSourceLifecycleState(key, { deleted: true });
      return;
    }
  }

  const db = getSqliteDatabase();
  db.transaction(() => {
    db.run("DELETE FROM resource_sources WHERE id=?", key);
    db.run("INSERT INTO deleted_sources(id,deleted_at) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET deleted_at=excluded.deleted_at", key, Date.now());
  });
}
export function setUnifiedSourceEnabled(id: string, enabled: boolean): SourceDefinition {
  const key = normalizeId(id);
  let source = getUnifiedSource(key);

  // An archived built-in channel source is intentionally absent from the active
  // catalog. Rehydrate its template so the same resource-source endpoint can
  // restore it without introducing a second channel-specific monitor path.
  if (!source && isChannelSourceId(key)) {
    source = buildUserSource(key);
  }
  if (!source) throw new Error("Unknown source");

  const next = { ...source, enabled: !!enabled };
  if (isChannelSourceId(key)) {
    setSourceLifecycleState(key, { enabled: !!enabled, deleted: false });
    // In explicit-channel mode the search scope is an explicit list, so the
    // lifecycle override alone would not change what a search loads. In
    // all-channels mode (null) the state table is the single source of truth.
    const settings = getSearchSettings();
    if (settings.channels !== null) {
      const channels = new Set(settings.channels);
      if (enabled) channels.add(key);
      else channels.delete(key);
      saveSearchSettings({ channels: [...channels] });
    }
    // A channel source may also have an explicitly persisted custom
    // definition. Keep that row's enabled flag in sync when it exists.
    if (getConfiguredSource(key)) writeSource(next);
    return clone(next);
  }
  writeSource(next);
  return clone(next);
}
export function getConfiguredSourceVersion(): string { return String(getSqliteDatabase().getRow<any>("SELECT revision FROM config_revisions WHERE scope='sources'")?.revision || 0); }
export function getUnifiedSourceVersion(): string { return `${getConfiguredSourceVersion()}|${getSearchSettingsVersion()}|${getSourceTemplateVersion()}`; }
export const SOURCE_CONFIG_SCHEMA_VERSION = 5;
export interface SourceConfigExport { schemaVersion: number; exportedAt: string; sources: SourceDefinition[]; }
export function exportConfiguredSources(): SourceConfigExport { return { schemaVersion: SOURCE_CONFIG_SCHEMA_VERSION, exportedAt: new Date().toISOString(), sources: listUnifiedSources() }; }
export function parseSourceConfigExport(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const text = raw.trim();
  const match = /^export\s+default\s+([\s\S]*?);?\s*$/.exec(text);
  try { return JSON.parse(match ? match[1]!.trim() : text); } catch { throw new Error("来源配置文件必须是 JSON 或由系统导出的 JS 文件"); }
}
export function importConfiguredSources(raw: unknown, actor = "admin"): SourceDefinition[] {
  const payload = parseSourceConfigExport(raw);
  const entries = Array.isArray(payload) ? payload : payload && typeof payload === "object" && Array.isArray((payload as any).sources) ? (payload as any).sources : [];
  if (!entries.length || entries.length > 100) throw new Error("sources 必须包含 1-100 个配置");

  // Validate every entry before opening the write transaction. A malformed
  // later entry must not leave earlier sources partially imported.
  const prepared = entries.map((entry: unknown, index: number) => prepareUnifiedSource(entry, index));
  const db = getSqliteDatabase();
  db.transaction(() => {
    for (const source of prepared) writeSource(source);
  });
  void actor;
  return prepared.map(clone);
}
