import { getSqliteDatabase } from "../storage/sqlite";
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

/** Runtime settings are seeded once and then kept in SQLite. */
export function getSystemSettings(fallback: unknown = {}): SystemSettingsSeed {
  const db = getSqliteDatabase();
  const row = db.getRow<any>("SELECT default_concurrency,request_timeout_ms,cache_ttl_minutes FROM system_settings WHERE id=1");
  if (row) {
    const cacheTtlMinutes = normalizeCacheTtlMinutes(row.cache_ttl_minutes);
    if (cacheTtlMinutes !== Number(row.cache_ttl_minutes)) {
      db.run("UPDATE system_settings SET cache_ttl_minutes=?,updated_at=? WHERE id=1", cacheTtlMinutes, Date.now());
    }
    return {
      defaultConcurrency: row.default_concurrency,
      requestTimeoutMs: normalizeTimeout(row.request_timeout_ms, SYSTEM_DEFAULTS.requestTimeoutMs),
      cacheTtlMinutes,
    };
  }

  const override = fallback && typeof fallback === "object" && !Array.isArray(fallback)
    ? fallback as Partial<SystemSettingsSeed>
    : {};
  const bootstrap = { ...SYSTEM_DEFAULTS, ...override };
  const seed: SystemSettingsSeed = {
    defaultConcurrency: Number(bootstrap.defaultConcurrency) || SYSTEM_DEFAULTS.defaultConcurrency,
    requestTimeoutMs: normalizeTimeout(bootstrap.requestTimeoutMs, SYSTEM_DEFAULTS.requestTimeoutMs),
    cacheTtlMinutes: normalizeCacheTtlMinutes(bootstrap.cacheTtlMinutes),
  };
  db.run(
    "INSERT OR REPLACE INTO system_settings(id,default_concurrency,request_timeout_ms,cache_ttl_minutes,updated_at) VALUES(1,?,?,?,?)",
    seed.defaultConcurrency,
    seed.requestTimeoutMs,
    seed.cacheTtlMinutes,
    Date.now(),
  );
  return seed;
}

export function saveSystemSettings(patch: Partial<SystemSettingsSeed>): SystemSettingsSeed {
  const current = getSystemSettings(patch);
  const value: SystemSettingsSeed = {
    ...current,
    ...(patch.defaultConcurrency !== undefined ? { defaultConcurrency: Number(patch.defaultConcurrency) } : {}),
    ...(patch.requestTimeoutMs !== undefined ? { requestTimeoutMs: normalizeTimeout(patch.requestTimeoutMs, current.requestTimeoutMs) } : {}),
    ...(patch.cacheTtlMinutes !== undefined ? { cacheTtlMinutes: normalizeCacheTtlMinutes(patch.cacheTtlMinutes, current.cacheTtlMinutes) } : {}),
  };
  getSqliteDatabase().run(
    "INSERT INTO system_settings(id,default_concurrency,request_timeout_ms,cache_ttl_minutes,updated_at) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET default_concurrency=excluded.default_concurrency,request_timeout_ms=excluded.request_timeout_ms,cache_ttl_minutes=excluded.cache_ttl_minutes,updated_at=excluded.updated_at",
    value.defaultConcurrency,
    value.requestTimeoutMs,
    value.cacheTtlMinutes,
    Date.now(),
  );
  return value;
}
