import { getSqliteDatabase } from "../storage/sqlite";
import { normalizeTelegramChannels } from "../../../utils/telegramChannels";
import { SYSTEM_DEFAULTS } from "./systemDefaults";

export interface SystemSettingsSeed {
  priorityChannels: string[];
  defaultChannels: string[];
  defaultConcurrency: number;
  pluginTimeoutMs: number;
  cacheTtlMinutes: number;
}

/**
 * Defaults are seeded into SQLite on first boot, then all runtime values are
 * read from SQLite. The shared defaults module is only a recoverable bootstrap source.
 */
export function getSystemSettings(fallback: unknown = {}): SystemSettingsSeed {
  const db = getSqliteDatabase();
  const row = db.getRow<any>("SELECT default_concurrency,plugin_timeout_ms,cache_ttl_minutes FROM system_settings WHERE id=1");
  const channels = (kind: string) => db.allRows<any>("SELECT name FROM system_channels WHERE kind=? ORDER BY position", kind).map(item => item.name);
  if (row) return { priorityChannels: normalizeTelegramChannels(channels("priority")), defaultChannels: normalizeTelegramChannels(channels("default")), defaultConcurrency: row.default_concurrency, pluginTimeoutMs: row.plugin_timeout_ms, cacheTtlMinutes: row.cache_ttl_minutes };
  // 只有首次初始化时才使用默认值；已有 SQLite 配置始终优先。
  // fallback 仅保留给测试和显式运行时覆盖，不会引入任何默认频道。
  const override = fallback && typeof fallback === "object" && !Array.isArray(fallback)
    ? fallback as Partial<SystemSettingsSeed>
    : {};
  const bootstrap = { ...SYSTEM_DEFAULTS, ...override };
  const seed: SystemSettingsSeed = {
    priorityChannels: normalizeTelegramChannels(Array.from(bootstrap.priorityChannels || [])),
    defaultChannels: normalizeTelegramChannels(Array.from(bootstrap.defaultChannels || [])),
    defaultConcurrency: Number(bootstrap.defaultConcurrency) || SYSTEM_DEFAULTS.defaultConcurrency,
    pluginTimeoutMs: Number(bootstrap.pluginTimeoutMs) || SYSTEM_DEFAULTS.pluginTimeoutMs,
    cacheTtlMinutes: Number(bootstrap.cacheTtlMinutes) || SYSTEM_DEFAULTS.cacheTtlMinutes,
  };
  const dbSeed = getSqliteDatabase();
  dbSeed.transaction(() => {
    dbSeed.run("INSERT OR REPLACE INTO system_settings(id,default_concurrency,plugin_timeout_ms,cache_ttl_minutes,updated_at) VALUES(1,?,?,?,?)", seed.defaultConcurrency, seed.pluginTimeoutMs, seed.cacheTtlMinutes, Date.now());
    dbSeed.run("DELETE FROM system_channels");
    for (const [position, name] of seed.priorityChannels.entries()) dbSeed.run("INSERT INTO system_channels(kind,name,position) VALUES(?,?,?)", "priority", name, position);
    for (const [position, name] of seed.defaultChannels.entries()) dbSeed.run("INSERT INTO system_channels(kind,name,position) VALUES(?,?,?)", "default", name, position);
  });
  return seed;
}

export function saveSystemSettings(patch: Partial<SystemSettingsSeed>): SystemSettingsSeed {
  const current = getSystemSettings(patch);
  const value: SystemSettingsSeed = { ...current, ...(patch.priorityChannels ? { priorityChannels: normalizeTelegramChannels(patch.priorityChannels) } : {}), ...(patch.defaultChannels ? { defaultChannels: normalizeTelegramChannels(patch.defaultChannels) } : {}), ...(patch.defaultConcurrency !== undefined ? { defaultConcurrency: Number(patch.defaultConcurrency) } : {}), ...(patch.pluginTimeoutMs !== undefined ? { pluginTimeoutMs: Number(patch.pluginTimeoutMs) } : {}), ...(patch.cacheTtlMinutes !== undefined ? { cacheTtlMinutes: Number(patch.cacheTtlMinutes) } : {}) };
  const db = getSqliteDatabase();
  db.transaction(() => {
    db.run("INSERT INTO system_settings(id,default_concurrency,plugin_timeout_ms,cache_ttl_minutes,updated_at) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET default_concurrency=excluded.default_concurrency,plugin_timeout_ms=excluded.plugin_timeout_ms,cache_ttl_minutes=excluded.cache_ttl_minutes,updated_at=excluded.updated_at", value.defaultConcurrency, value.pluginTimeoutMs, value.cacheTtlMinutes, Date.now());
    db.run("DELETE FROM system_channels");
    for (const [position, name] of value.priorityChannels.entries()) db.run("INSERT INTO system_channels(kind,name,position) VALUES(?,?,?)", "priority", name, position);
    for (const [position, name] of value.defaultChannels.entries()) db.run("INSERT INTO system_channels(kind,name,position) VALUES(?,?,?)", "default", name, position);
  });
  return value;
}
