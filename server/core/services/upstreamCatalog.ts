import { BUILTIN_UPSTREAMS, type UpstreamDefinition } from "../../../config/upstreams";
import { TG_CHANNEL_PATTERN, normalizeTelegramChannels } from "../../../utils/telegramChannels";
import { getSearchSettings, getSearchSettingsVersion, saveSearchSettings } from "./searchSettingsService";
import { getSystemSettings } from "./systemSettingsService";
import { getTgSourceSettings, getTgSourceSettingsVersion, buildConfiguredTgUrl } from "./tgSourceSettings";
import { getSqliteDatabase } from "../storage/sqlite";
import { validateOutboundUrl } from "../security/outboundUrl";
import { upstreamToInstructionDefinition } from "./configuredUpstreamPlugin";
import { validateInstructionDefinition } from "../instructions/validator";
import { validateParserCode } from "../parsers/repository";
import {
  clearTgChannelState,
  getTgChannelState,
  getTgChannelStates,
  setTgChannelState,
} from "./tgChannelSettings";

const NAMESPACE = "upstream_catalog";
const KEY = "definitions";
const DELETED_KEY = "deleted";
const TRANSFORM_MIGRATION_KEY = "default_transforms_migrated";
const ID_RE = /^[a-z0-9][a-z0-9_-]{1,79}$/;
const HTTP_ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const MAX_TAGS = 24;
const MAX_TAG_LENGTH = 40;
const MAX_RESOURCE_TYPES = 16;
const MAX_RESOURCE_TYPE_LENGTH = 40;

type StoredCatalog = Record<string, UpstreamDefinition>;

function clone<T>(value: T): T { return structuredClone(value); }

function stringList(raw: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().slice(0, maxLength))
    .filter(Boolean))].slice(0, maxItems);
}

function validateUrlList(raw: unknown): string[] {
  return stringList(raw, 3, 2_000).filter((url) => {
    try {
      const sample = url
        .replaceAll("{{channel}}", "panhub_channel")
        .replaceAll("{{keyword}}", encodeURIComponent("demo"))
        .replaceAll("{{page}}", "1");
      validateOutboundUrl(sample, { allowHttp: false });
      return true;
    } catch { return false; }
  });
}

function validateSourceUrl(url: string, sourceKind: "http" | "telegram"): void {
  const sample = sourceKind === "telegram"
    ? url.replaceAll("{{channel}}", "panhub_channel").replaceAll("{{keyword}}", encodeURIComponent("demo"))
    : url;
  validateOutboundUrl(sample, { allowHttp: false });
}

function telegramUrl(route: "direct" | "jina", channel: string): string {
  return buildConfiguredTgUrl(route, channel, "");
}

function runtimeDefaultChannels(): string[] {
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
    const mapping = source.mapping && typeof source.mapping === "object" ? source.mapping : {};
    out[id] = {
      id,
      ...(sourceKind === "telegram" ? { sourceKind: "telegram" as const, channel } : { sourceKind: "http" as const }),
      name: String(source.name || id).trim().slice(0, 100),
      description: String(source.description || "").trim().slice(0, 500),
      url,
      ...(source.fallbackUrls !== undefined ? { fallbackUrls: validateUrlList(source.fallbackUrls) } : {}),
      ...(source.retry && typeof source.retry === "object" && !Array.isArray(source.retry)
        ? { retry: {
            ...(Number.isInteger(source.retry.maxRetries) ? { maxRetries: Math.min(3, Math.max(0, Number(source.retry.maxRetries))) } : {}),
            ...(Number.isInteger(source.retry.delayMs) ? { delayMs: Math.min(5_000, Math.max(0, Number(source.retry.delayMs))) } : {}),
          } }
        : {}),
      tags: stringList(source.tags, MAX_TAGS, MAX_TAG_LENGTH),
      driveType: typeof source.driveType === "string" ? source.driveType.trim().slice(0, MAX_TAG_LENGTH) : "",
      resourceTypes: stringList(source.resourceTypes, MAX_RESOURCE_TYPES, MAX_RESOURCE_TYPE_LENGTH),
      method,
      format,
      plugin: String(source.plugin || id).trim().slice(0, 100),
      adapter: String(source.adapter || "").trim().slice(0, 100),
      color: String(source.color || "#697fbd").trim().slice(0, 20),
      initials: String(source.initials || id.slice(0, 1)).trim().slice(0, 3),
      mapping: {
        items: String((mapping as any).items || "").slice(0, 200),
        title: String((mapping as any).title || "").slice(0, 200),
        url: String((mapping as any).url || "").slice(0, 200),
        type: String((mapping as any).type || "").slice(0, 200),
        password: String((mapping as any).password || "").slice(0, 200),
        content: String((mapping as any).content || "").slice(0, 200),
        datetime: String((mapping as any).datetime || "").slice(0, 200),
        ...((mapping as any).linkArray ? { linkArray: String((mapping as any).linkArray).slice(0, 200) } : {}),
      },
      ...(source.runtime && typeof source.runtime === "object" && (source.runtime as any).kind === "core" && typeof (source.runtime as any).handler === "string"
        ? { runtime: { kind: "core" as const, handler: String((source.runtime as any).handler).slice(0, 64), urls: Array.isArray((source.runtime as any).urls) ? (source.runtime as any).urls.map(String).slice(0, 8) : undefined } }
        : {}),
      ...(source.retry && typeof source.retry === "object" && !Array.isArray(source.retry)
        ? { retry: { maxRetries: Number.isInteger((source.retry as any).maxRetries) ? Math.max(0, Math.min(3, (source.retry as any).maxRetries)) : undefined, delayMs: Number.isInteger((source.retry as any).delayMs) ? Math.max(0, Math.min(5_000, (source.retry as any).delayMs)) : undefined } }
        : {}),
      ...(source.request && typeof source.request === "object" && !Array.isArray(source.request)
        ? { request: structuredClone(source.request) }
        : {}),
      ...(typeof source.transform === "string" && source.transform.trim()
        ? { transform: source.transform.slice(0, 100_000) }
        : {}),
      ...(source.response && typeof source.response === "object" && !Array.isArray(source.response)
        ? { response: structuredClone(source.response) }
        : {}),
      enabled: source.enabled !== false,
      // Compatibility field for older clients; sourceKind is authoritative.
      builtin: source.builtin !== false,
    };
  }
  return out;
}

function readIdSet(store: ReturnType<typeof getSqliteDatabase>, key: string): Set<string> {
  const raw = store.get<unknown>(NAMESPACE, key, []);
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.map((value) => String(value || "").trim().toLowerCase()).filter((id) => ID_RE.test(id)));
}

function read(): StoredCatalog {
  const store = getSqliteDatabase();
  const deleted = readIdSet(store, DELETED_KEY);
  const migratedTransforms = readIdSet(store, TRANSFORM_MIGRATION_KEY);
  const existing = sanitize(store.get<unknown>(NAMESPACE, KEY, {}));
  // Normalize seeds through the same sanitizer as persisted rows so the
  // first read and subsequent SQLite reads produce stable versions.
  const seed = sanitize(Object.fromEntries(BUILTIN_UPSTREAMS.map((source) => [source.id, clone(source)])));
  let migrationChanged = false;
  const merged = Object.fromEntries(Object.keys(seed)
    .filter((id) => !deleted.has(id))
    .map((id) => {
      const persisted = existing[id];
      if (!persisted) {
        // Treat shipped configurations as ordinary catalog rows. Remember that
        // their default transform has already been applied so a later user
        // save that intentionally clears it is not overwritten on read.
        if (seed[id]?.transform && !migratedTransforms.has(id)) {
          migratedTransforms.add(id);
          migrationChanged = true;
        }
        return [id, seed[id]!];
      }
      const next = { ...seed[id]!, ...persisted } as UpstreamDefinition;
      // Once a row has been saved, its optional executable fields are
      // authoritative, except for the one-time migration of old rows that
      // predate persisted transforms.
      for (const key of ["runtime", "request", "response", "transform"] as const) {
        if (!Object.prototype.hasOwnProperty.call(persisted, key)) delete next[key];
      }
      if (!Object.prototype.hasOwnProperty.call(persisted, "transform") &&
          seed[id]?.transform && !migratedTransforms.has(id)) {
        next.transform = seed[id]!.transform;
        migratedTransforms.add(id);
        migrationChanged = true;
      } else if (Object.prototype.hasOwnProperty.call(persisted, "transform") && !migratedTransforms.has(id)) {
        migratedTransforms.add(id);
        migrationChanged = true;
      }
      return [id, next];
    })) as StoredCatalog;
  // Preserve user-created catalog rows, but never resurrect a deleted row.
  for (const [id, source] of Object.entries(existing)) {
    if (!deleted.has(id) && !merged[id]) merged[id] = source;
  }

  const needsSeedMigration = Object.entries(seed).some(([id, source]) => {
    if (deleted.has(id)) return false;
    const current = existing[id];
    return !current ||
      current.builtin !== true ||
      current.enabled === undefined ||
      current.runtime?.kind !== source.runtime?.kind ||
      current.runtime?.handler !== source.runtime?.handler;
  });
  if (!Object.keys(existing).length || needsSeedMigration || migrationChanged) {
    store.set(NAMESPACE, KEY, merged);
    store.set(NAMESPACE, TRANSFORM_MIGRATION_KEY, [...migratedTransforms]);
  }
  return merged;
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
  const fallbackUrls = stored && Object.prototype.hasOwnProperty.call(stored, "fallbackUrls")
    ? stored.fallbackUrls
    : [telegramUrl("jina", channel)];
  const source = {
    id,
    sourceKind: "telegram" as const,
    channel,
    name: stored?.name || `@${channel}`,
    description: stored?.description || "Telegram 频道上游",
    url: stored?.url || telegramUrl("direct", channel),
    fallbackUrls,
    tags: stored?.tags?.length ? stored.tags : ["telegram"],
    driveType: stored?.driveType || "",
    resourceTypes: stored?.resourceTypes || [],
    method: "GET" as const,
    format: "html" as const,
    plugin: stored?.plugin || id,
    adapter: stored?.adapter || "configured-transform",
    color: stored?.color || "#4c8ed9",
    initials: stored?.initials || "T",
    mapping: stored?.mapping || { items: "", title: "", url: "", type: "", password: "" },
    builtin: stored?.builtin !== false,
    enabled: state ? state.enabled && !state.deleted : stored?.enabled !== false,
    retry: stored?.retry || { maxRetries: 1, delayMs: 250 },
    request: stored?.request || {
      fallbackUrls,
      query: { q: "{{keyword}}" },
      headers: settings.headers,
      timeoutMs: 10_000,
    },
    transform: stored?.transform || settings.transform,
    response: stored?.response || {},
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
    ...runtimeDefaultChannels(),
    ...(settings.channels || []),
    ...Object.keys(states),
    ...Object.keys(catalog).filter((id) => id.startsWith("tg-")).map((id) => id.slice(3)),
  ]);
  const telegram = [...channels]
    .map((channel) => channel.replace(/^@/, "").toLowerCase())
    .filter((channel) => TG_CHANNEL_PATTERN.test(channel) && !states[channel]?.deleted)
    .map((channel) => buildTelegramDefinition(channel, catalog[telegramId(channel)]));
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

export function saveConfiguredUpstream(raw: unknown): UpstreamDefinition {
  const value = raw && typeof raw === "object" ? raw as Partial<UpstreamDefinition> : {};
  const id = String(value.id || "").trim().toLowerCase();
  const catalog = read();
  const current = catalog[id];
  const merged = { ...current, ...value, id, builtin: true } as Partial<UpstreamDefinition>;
  // Older rows may still carry a generated transform alongside field mapping.
  // If only the request/mapping is edited and the transform was not changed,
  // drop that stale generated code so the edited configuration is executable.
  const executableChanged = !!current && (
    value.url !== undefined && value.url !== current.url ||
    value.method !== undefined && value.method !== current.method ||
    value.format !== undefined && value.format !== current.format ||
    value.mapping !== undefined && JSON.stringify(value.mapping) !== JSON.stringify(current.mapping) ||
    value.request !== undefined && JSON.stringify(value.request) !== JSON.stringify(current.request) ||
    value.response !== undefined && JSON.stringify(value.response) !== JSON.stringify(current.response)
  );
  if (executableChanged && typeof value.transform === "string" && value.transform.trim() === (current.transform || "").trim()) {
    delete merged.transform;
  }
  const next = sanitize({ [id]: merged })[id];
  if (!next) throw new Error("上游配置无效：请检查 ID、HTTPS 地址、请求方式和响应格式");
  // Validate the complete declarative shape before committing. Core-backed
  // sources use the same adapter defaults, so malformed request/mapping JSON
  // can never become the runtime truth. Transform code is validated with the
  // same syntax/keyword policy as published parser plugins.
  if (next.transform?.trim()) validateParserCode(next.transform);
  validateInstructionDefinition(upstreamToInstructionDefinition(next));
  catalog[id] = next;
  const store = getSqliteDatabase();
  const deleted = readIdSet(store, DELETED_KEY);
  if (deleted.delete(id)) store.set(NAMESPACE, DELETED_KEY, [...deleted]);
  store.set(NAMESPACE, KEY, catalog);
  return clone(next);
}

export function saveConfiguredTelegramUpstream(raw: unknown): UpstreamDefinition {
  const value = raw && typeof raw === "object" ? raw as Partial<UpstreamDefinition> : {};
  const rawChannel = String(value.channel || (String(value.id || "").toLowerCase().startsWith("tg-") ? String(value.id).slice(3) : ""));
  const channel = rawChannel.trim().replace(/^@/, "").toLowerCase();
  if (!TG_CHANNEL_PATTERN.test(channel)) throw new Error("Telegram 上游必须填写有效的公开频道用户名");
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
    fallbackUrls: value.fallbackUrls !== undefined ? value.fallbackUrls : current?.fallbackUrls || [telegramUrl("jina", channel)],
    retry: value.retry !== undefined ? value.retry : current?.retry || { maxRetries: 1, delayMs: 250 },
    request: value.request !== undefined ? value.request : current?.request || { fallbackUrls: [telegramUrl("jina", channel)], headers: getTgSourceSettings().headers, query: { q: "{{keyword}}" }, timeoutMs: 10_000 },
    transform: value.transform !== undefined ? value.transform : current?.transform || getTgSourceSettings().transform,
  };
  const next = sanitize({ [id]: nextInput })[id];
  if (!next) throw new Error("Telegram 上游配置无效：请检查频道、HTTPS 地址、请求配置和响应格式");
  if (next.transform?.trim()) validateParserCode(next.transform);
  validateInstructionDefinition(upstreamToInstructionDefinition(next));
  catalog[id] = next;
  const settings = getSearchSettings();
  const configured = settings.channels === null ? runtimeDefaultChannels() : settings.channels;
  if (!configured.includes(channel)) saveSearchSettings({ channels: [...configured, channel] });
  clearTgChannelState(channel);
  getSqliteDatabase().set(NAMESPACE, KEY, catalog);
  return clone(next);
}

export function saveUnifiedUpstream(raw: unknown): UpstreamDefinition {
  const value = raw && typeof raw === "object" ? raw as Partial<UpstreamDefinition> : {};
  return isTelegramSource(value) ? saveConfiguredTelegramUpstream(value) : saveConfiguredUpstream(value);
}

export function deleteConfiguredTelegramUpstream(idOrChannel: string): void {
  const raw = String(idOrChannel || "").trim().toLowerCase();
  const channel = raw.startsWith("tg-") ? raw.slice(3) : raw.replace(/^@/, "");
  if (!TG_CHANNEL_PATTERN.test(channel)) throw new Error("Unknown Telegram upstream");
  const settings = getSearchSettings();
  const defaults = runtimeDefaultChannels();
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
    delete catalog[telegramId(channel)];
    getSqliteDatabase().set(NAMESPACE, KEY, catalog);
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
    getSqliteDatabase().set(NAMESPACE, KEY, { ...read(), [source.id]: next });
    return clone(buildTelegramDefinition(source.channel, next));
  }
  return setConfiguredUpstreamEnabled(source.id, enabled);
}

export function deleteConfiguredUpstream(id: string): void {
  const key = String(id || "").trim().toLowerCase();
  const store = getSqliteDatabase();
  const catalog = read();
  if (!catalog[key]) throw new Error("Unknown upstream");
  const deleted = readIdSet(store, DELETED_KEY);
  deleted.add(key);
  delete catalog[key];
  store.transaction(() => {
    store.set(NAMESPACE, KEY, catalog);
    store.set(NAMESPACE, DELETED_KEY, [...deleted]);
  });
}

export function setConfiguredUpstreamEnabled(id: string, enabled: boolean): UpstreamDefinition {
  const catalog = read();
  const key = String(id || "").trim().toLowerCase();
  const current = catalog[key];
  if (!current) throw new Error("Unknown upstream");
  const next = { ...current, enabled: !!enabled };
  catalog[key] = next;
  getSqliteDatabase().set(NAMESPACE, KEY, catalog);
  return clone(next);
}

export function getConfiguredUpstreamVersion(): string {
  const db = getSqliteDatabase();
  // Seed first, then read the timestamp. This keeps the version stable even
  // for the very first request that creates the SQLite catalog row.
  const catalog = read();
  return `${db.getUpdatedAt(NAMESPACE, KEY) ?? 0}:${db.getUpdatedAt(NAMESPACE, DELETED_KEY) ?? 0}:${JSON.stringify(catalog)}`;
}


export function getUnifiedUpstreamVersion(): string {
  return `${getConfiguredUpstreamVersion()}|${getSearchSettingsVersion()}|${getTgSourceSettingsVersion()}|${JSON.stringify(listUnifiedUpstreams())}`;
}

export const UPSTREAM_CONFIG_SCHEMA_VERSION = 2;

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
    throw new Error("上游配置文件必须是 JSON 或由系统导出的 JS 文件");
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
    const value = entry && typeof entry === "object" ? entry as Partial<UpstreamDefinition> : {};
    const id = String(value.id || "").trim().toLowerCase();
    if (isTelegramSource(value)) {
      const saved = saveConfiguredTelegramUpstream(value);
      nextCatalog[saved.id] = saved;
      imported.push(saved);
      continue;
    }
    const next = sanitize({ [id]: { ...catalog[id], ...value, id, builtin: true } })[id];
    if (!next) throw new Error(`上游配置无效: ${id || "缺少 id"}`);
    if (next.transform?.trim()) validateParserCode(next.transform);
    validateInstructionDefinition(upstreamToInstructionDefinition(next));
    nextCatalog[id] = next;
    imported.push(clone(next));
  }
  const store = getSqliteDatabase();
  const deleted = readIdSet(store, DELETED_KEY);
  for (const source of imported) deleted.delete(source.id);
  store.transaction(() => {
    store.set(NAMESPACE, KEY, nextCatalog);
    store.set(NAMESPACE, DELETED_KEY, [...deleted]);
  });
  void actor;
  return imported;
}
