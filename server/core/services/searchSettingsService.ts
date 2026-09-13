import { normalizeTelegramChannels, TG_CHANNEL_PATTERN } from "../../../utils/telegramChannels";
import { mkdirSync, readFileSync, writeFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { getSqliteDatabase } from "../storage/sqlite";

/**
 * 管理端搜索配置的 SQLite 存储。
 *
 * 旧版 data/search-settings.json 会在 SQLite 首次创建时被导入到
 * json_store(search_settings/state)，原文件保留作为恢复副本。之后所有读写
 * 都只走 SQLite，避免多个 JSON 文件之间出现配置覆盖和热更新延迟。
 */
export interface SearchSettings {
  plugins: string[] | null;
  channels: string[] | null;
  concurrency: number | null;
  pluginTimeoutMs: number | null;
  trashedPlugins: string[];
}

const DEFAULT_SETTINGS: SearchSettings = {
  plugins: null,
  channels: null,
  concurrency: null,
  pluginTimeoutMs: null,
  trashedPlugins: [],
};
const MAX_CHANNELS = 200;
const DB_NAMESPACE = "search_settings";
const DB_KEY = "state";
function getLegacyPath(): string | undefined {
  const value = process.env.PANHUB_SEARCH_SETTINGS_STORE?.trim();
  return value || undefined;
}
let legacyCached: SearchSettings | null = null;
let legacyStamp: string | null = null;
let legacyCheckedAt = 0;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function getStore() {
  return getSqliteDatabase();
}


function legacySignature(): string | null {
  const path = getLegacyPath();
  if (!path) return null;
  try { const s = statSync(path); return `${Math.round(s.mtimeMs)}:${s.size}`; } catch { return null; }
}
function getLegacySettings(): SearchSettings {
  const now = Date.now();
  const stamp = legacySignature();
  const configuredRecheck = Number(process.env.PANHUB_SEARCH_SETTINGS_RECHECK_MS);
  const recheckMs = Number.isFinite(configuredRecheck) && configuredRecheck >= 0 ? configuredRecheck : 1500;
  if (legacyCached && now - legacyCheckedAt < recheckMs) return legacyCached;
  legacyCheckedAt = now;
  if (!stamp) { legacyCached = { ...DEFAULT_SETTINGS }; legacyStamp = null; return legacyCached; }
  if (legacyCached && stamp === legacyStamp) return legacyCached;
  const path = getLegacyPath();
  try { legacyCached = sanitize(JSON.parse(readFileSync(path!, "utf8"))); legacyStamp = stamp; } catch { legacyCached = { ...DEFAULT_SETTINGS }; legacyStamp = stamp; }
  return legacyCached;
}
function saveLegacySettings(next: SearchSettings): void {
  const path = getLegacyPath();
  if (!path) throw new Error("legacy search settings path is not configured");
  mkdirSync(dirname(path), { recursive: true }); const tmp = `${path}.${process.pid}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8"); renameSync(tmp, path); }
  catch (error) { try { unlinkSync(tmp); } catch {} throw error; }
  legacyCached = next; legacyStamp = legacySignature(); legacyCheckedAt = Date.now();
}

function sanitize(raw: unknown): SearchSettings {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const strList = (input: unknown, filter?: (s: string) => boolean): string[] | null => {
    if (!Array.isArray(input)) return null;
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of input) {
      if (typeof item !== "string") continue;
      const name = item.trim();
      if (!name || seen.has(name)) continue;
      if (filter && !filter(name)) continue;
      seen.add(name);
      result.push(name);
    }
    return result;
  };

  const plugins = strList(value.plugins, (s) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(s));
  const rawChannels = strList(value.channels);
  const channels = rawChannels === null
    ? null
    : normalizeTelegramChannels(rawChannels).filter((name) => TG_CHANNEL_PATTERN.test(name));
  if (channels && channels.length > MAX_CHANNELS) channels.length = MAX_CHANNELS;
  const trashedPlugins = strList(value.trashedPlugins, (s) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(s)) || [];

  const concurrency = typeof value.concurrency === "number" && value.concurrency >= 1 && value.concurrency <= 16
    ? Math.round(value.concurrency)
    : null;
  const pluginTimeoutMs = typeof value.pluginTimeoutMs === "number" && value.pluginTimeoutMs >= 1000 && value.pluginTimeoutMs <= 60_000
    ? Math.round(value.pluginTimeoutMs)
    : null;
  return { plugins, channels, concurrency, pluginTimeoutMs, trashedPlugins };
}

export function getSearchSettings(): SearchSettings {
  if (getLegacyPath()) return clone(getLegacySettings());
  return clone(sanitize(getStore().get(DB_NAMESPACE, DB_KEY, DEFAULT_SETTINGS)));
}

/** Opaque, process-local-independent version used by consumers that need to observe changes. */
export function getSearchSettingsVersion(): string | null {
  if (getLegacyPath()) return legacySignature();
  return JSON.stringify(getSearchSettings());
}

export function saveSearchSettings(patch: unknown): SearchSettings {
  const current = getSearchSettings();
  const merged = {
    ...current,
    ...((patch && typeof patch === "object" ? patch : {}) as Record<string, unknown>),
  };
  const next = sanitize(merged);
  if (getLegacyPath()) saveLegacySettings(next);
  else getStore().set(DB_NAMESPACE, DB_KEY, next);
  return clone(next);
}

/** 从垃圾箱恢复 / 放入垃圾箱（仅适用于页面发布的规则插件）。 */
export function setPluginTrashed(id: string, trashed: boolean): SearchSettings {
  const current = getSearchSettings();
  const set = new Set(current.trashedPlugins);
  if (trashed) set.add(id);
  else set.delete(id);
  return saveSearchSettings({ trashedPlugins: [...set] });
}
