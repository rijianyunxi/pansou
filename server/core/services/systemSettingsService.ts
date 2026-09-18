import { getSqliteDatabase } from "../storage/sqlite";
import { normalizeChannelNames } from "../../../utils/customChannels";
import { SYSTEM_DEFAULTS } from "./systemDefaults";

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
function normalizeTimeout(value: unknown, fallback: number): number {
  const parsed = Number(value);
  const safeFallback = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(Number(fallback) || SYSTEM_DEFAULTS.requestTimeoutMs)));
  return Number.isFinite(parsed)
    ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(parsed)))
    : safeFallback;
}

export interface SystemSettingsSeed {
  priorityChannels: string[];
  defaultChannels: string[];
  defaultConcurrency: number;
  requestTimeoutMs: number;
  cacheTtlMinutes: number;
}

export function normalizeCacheTtlMinutes(value: unknown, fallback: number = SYSTEM_DEFAULTS.cacheTtlMinutes): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 10
    ? Math.round(parsed)
    : fallback;
}

/**
 * Ids the operator deleted through the source console.
 *
 * `sourceCatalog.read()` already hides these from the active catalogue, but
 * `system_channels` is written straight from the settings form and had no such
 * filter: a deleted source could be saved back into the default channel list and
 * then stay there forever — the console reads this table directly, and so did
 * the public health endpoint. The lookup lives here rather than in the catalogue
 * because the catalogue imports this module (importing it back would be a cycle).
 */
function deletedSourceIds(): Set<string> {
  return new Set(
    getSqliteDatabase()
      .allRows<{ id: string }>("SELECT id FROM deleted_sources")
      .map((row) => String(row.id).trim().toLowerCase()),
  );
}

/** Drop deleted ids so a retired source can never re-enter the channel lists. */
function keepLiveChannels(names: string[], deleted: ReadonlySet<string>): string[] {
  return normalizeChannelNames(names).filter((name) => !deleted.has(name));
}

/**
 * Defaults are seeded into SQLite on first boot, then all runtime values are
 * read from SQLite. The shared defaults module is only a recoverable bootstrap source.
 */
export function getSystemSettings(fallback: unknown = {}): SystemSettingsSeed {
  const db = getSqliteDatabase();
  const row = db.getRow<any>("SELECT default_concurrency,request_timeout_ms,cache_ttl_minutes FROM system_settings WHERE id=1");
  const deleted = deletedSourceIds();
  const channels = (kind: string) => keepLiveChannels(
    db.allRows<any>("SELECT name FROM system_channels WHERE kind=? ORDER BY position", kind).map(item => item.name),
    deleted,
  );
  if (row) {
    const cacheTtlMinutes = normalizeCacheTtlMinutes(row.cache_ttl_minutes);
    // Migrate an older out-of-range value (for example the former 30-minute
    // default) into the persisted setting that the admin UI will display.
    if (cacheTtlMinutes !== Number(row.cache_ttl_minutes)) {
      db.run("UPDATE system_settings SET cache_ttl_minutes=?,updated_at=? WHERE id=1", cacheTtlMinutes, Date.now());
    }
    return { priorityChannels: channels("priority"), defaultChannels: channels("default"), defaultConcurrency: row.default_concurrency, requestTimeoutMs: normalizeTimeout(row.request_timeout_ms, SYSTEM_DEFAULTS.requestTimeoutMs), cacheTtlMinutes };
  }
  // 只有首次初始化时才使用默认值；已有 SQLite 配置始终优先。
  // fallback 仅保留给测试和显式运行时覆盖，不会引入任何默认频道。
  const override = fallback && typeof fallback === "object" && !Array.isArray(fallback)
    ? fallback as Partial<SystemSettingsSeed>
    : {};
  const bootstrap = { ...SYSTEM_DEFAULTS, ...override };
  const seed: SystemSettingsSeed = {
    priorityChannels: keepLiveChannels(Array.from(bootstrap.priorityChannels || []), deleted),
    defaultChannels: keepLiveChannels(Array.from(bootstrap.defaultChannels || []), deleted),
    defaultConcurrency: Number(bootstrap.defaultConcurrency) || SYSTEM_DEFAULTS.defaultConcurrency,
    requestTimeoutMs: normalizeTimeout(bootstrap.requestTimeoutMs, SYSTEM_DEFAULTS.requestTimeoutMs),
    cacheTtlMinutes: normalizeCacheTtlMinutes(bootstrap.cacheTtlMinutes),
  };
  const dbSeed = getSqliteDatabase();
  dbSeed.transaction(() => {
    dbSeed.run("INSERT OR REPLACE INTO system_settings(id,default_concurrency,request_timeout_ms,cache_ttl_minutes,updated_at) VALUES(1,?,?,?,?)", seed.defaultConcurrency, seed.requestTimeoutMs, seed.cacheTtlMinutes, Date.now());
    const seedChannels = [...seed.priorityChannels.map(name => ["priority", name] as const), ...seed.defaultChannels.map(name => ["default", name] as const)];
    if (seedChannels.length) dbSeed.run(`DELETE FROM system_channels WHERE (kind,name) NOT IN (${seedChannels.map(() => "(?,?)").join(",")})`, ...seedChannels.flat());
    else dbSeed.run("DELETE FROM system_channels");
    for (const [position, name] of seed.priorityChannels.entries()) dbSeed.run("INSERT INTO system_channels(kind,name,position) VALUES(?,?,?) ON CONFLICT(kind,name) DO UPDATE SET position=excluded.position", "priority", name, position);
    for (const [position, name] of seed.defaultChannels.entries()) dbSeed.run("INSERT INTO system_channels(kind,name,position) VALUES(?,?,?) ON CONFLICT(kind,name) DO UPDATE SET position=excluded.position", "default", name, position);
  });
  return seed;
}

export function saveSystemSettings(patch: Partial<SystemSettingsSeed>): SystemSettingsSeed {
  const current = getSystemSettings(patch);
  // A deleted source must not be saved back into the lists: `current` is already
  // filtered, and the incoming patch is filtered here so a stale console page
  // cannot resurrect a retired channel.
  const deleted = deletedSourceIds();
  const value: SystemSettingsSeed = { ...current, ...(patch.priorityChannels ? { priorityChannels: keepLiveChannels(patch.priorityChannels, deleted) } : {}), ...(patch.defaultChannels ? { defaultChannels: keepLiveChannels(patch.defaultChannels, deleted) } : {}), ...(patch.defaultConcurrency !== undefined ? { defaultConcurrency: Number(patch.defaultConcurrency) } : {}), ...(patch.requestTimeoutMs !== undefined ? { requestTimeoutMs: normalizeTimeout(patch.requestTimeoutMs, current.requestTimeoutMs) } : {}), ...(patch.cacheTtlMinutes !== undefined ? { cacheTtlMinutes: normalizeCacheTtlMinutes(patch.cacheTtlMinutes, current.cacheTtlMinutes) } : {}) };
  const db = getSqliteDatabase();
  db.transaction(() => {
    db.run("INSERT INTO system_settings(id,default_concurrency,request_timeout_ms,cache_ttl_minutes,updated_at) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET default_concurrency=excluded.default_concurrency,request_timeout_ms=excluded.request_timeout_ms,cache_ttl_minutes=excluded.cache_ttl_minutes,updated_at=excluded.updated_at", value.defaultConcurrency, value.requestTimeoutMs, value.cacheTtlMinutes, Date.now());
    const channels = [...value.priorityChannels.map(name => ["priority", name] as const), ...value.defaultChannels.map(name => ["default", name] as const)];
    if (channels.length) db.run(`DELETE FROM system_channels WHERE (kind,name) NOT IN (${channels.map(() => "(?,?)").join(",")})`, ...channels.flat());
    else db.run("DELETE FROM system_channels");
    for (const [position, name] of value.priorityChannels.entries()) db.run("INSERT INTO system_channels(kind,name,position) VALUES(?,?,?) ON CONFLICT(kind,name) DO UPDATE SET position=excluded.position", "priority", name, position);
    for (const [position, name] of value.defaultChannels.entries()) db.run("INSERT INTO system_channels(kind,name,position) VALUES(?,?,?) ON CONFLICT(kind,name) DO UPDATE SET position=excluded.position", "default", name, position);
  });
  return value;
}
