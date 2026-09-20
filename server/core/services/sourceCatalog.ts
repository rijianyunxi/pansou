import type { SourceDefinition } from "../../../types/source";
import { getSearchSettings, getSearchSettingsVersion, saveSearchSettings } from "./searchSettingsService";
import { getSqliteDatabase } from "../storage/sqlite";
import { validateOutboundUrl } from "../security/outboundUrl";
import { toSourceDefinition, getSourceConfigurationVersion } from "./configuredSource";
import { validateSourceDefinition, validateSourceTransformCode } from "../source-runtime/validation";
import { buildSourceFromTemplate, getSourceTemplateVersion } from "./sourceTemplateSettings";
import { removeProxyRouteSourceReferences } from "./proxyRoutingService";

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
  const rows = db.allRows<any>("SELECT id,name,description,url,method,format,priority,enabled,request_json,transform FROM resource_sources");
  const raw: Record<string, unknown> = {};
  for (const row of rows) {
    const id = normalizeId(row.id);
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

/** Remove the persisted source and its runtime/search metadata. */
function removePersistedSourceArtifacts(id: string): void {
  const db = getSqliteDatabase();
  db.transaction(() => {
    db.run("DELETE FROM resource_sources WHERE id=?", id);
    db.run("DELETE FROM source_health WHERE source_id=?", id);
    db.run("DELETE FROM search_setting_sources WHERE source_id=?", id);
  });
  // Reconcile the configuration flags and timestamps after removing the row.
  // This also keeps any remaining explicit source selection intact.
  const settings = getSearchSettings();
  saveSearchSettings({
    sources: settings.sources?.filter((sourceId) => sourceId !== id) ?? null,
  });
  removeProxyRouteSourceReferences(id);
}
export function buildUserSource(channel: string): SourceDefinition {
  const normalized = normalizeChannel(channel);
  const template = buildSourceFromTemplate(normalized);
  return {
    id: normalized,
    name: `@${normalized}`,
    description: "用户资源源模板",
    url: template.url,
    method: template.method,
    format: template.format,
    priority: 0,
    enabled: true,
    request: template.request as SourceDefinition["request"],
    transform: template.transform,
  };
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
  return Object.values(read()).sort(compareSources).map(clone);
}
export function getUnifiedSource(id: string): SourceDefinition | undefined { return getConfiguredSource(id); }
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
  removePersistedSourceArtifacts(key);
}

export function setUnifiedSourceEnabled(id: string, enabled: boolean): SourceDefinition {
  const key = normalizeId(id);
  const source = getUnifiedSource(key);
  if (!source) throw new Error("Unknown source");

  const next = { ...source, enabled: !!enabled };
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
