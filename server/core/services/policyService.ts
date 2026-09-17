import { getSqliteDatabase } from "../storage/sqlite";

/**
 * 管理后台暴露的用户、频道和搜索运行策略。
 * 运行参数也归入这里，避免在资源源选择弹窗中分散配置。
 */
export interface UserPolicy {
  registrationEnabled: boolean;
  showAuthButtons: boolean;
  anonymousCustomChannels: boolean;
  sessionDays: number;
  customChannelLimit: number;
  defaultConcurrency: number;
  requestTimeoutMs: number;
  circuitBreakerMaxFailures: number;
  searchTimeoutMs: number;
  cacheTtlMinutes: number;
  searchRateLimitWindowSeconds: number;
  searchRateLimitPerSession: number;
  searchRateLimitPerIp: number;
}

export const DEFAULT_USER_POLICY: UserPolicy = {
  registrationEnabled: true,
  showAuthButtons: true,
  anonymousCustomChannels: false,
  sessionDays: 30,
  customChannelLimit: 10,
  defaultConcurrency: 4,
  requestTimeoutMs: 5000,
  circuitBreakerMaxFailures: 5,
  searchTimeoutMs: 30000,
  cacheTtlMinutes: 10,
  searchRateLimitWindowSeconds: 60,
  searchRateLimitPerSession: 30,
  searchRateLimitPerIp: 120,
};

const integerRanges: Record<string, [number, number]> = {
  sessionDays: [1, 365],
  customChannelLimit: [0, 100],
  defaultConcurrency: [1, 16],
  requestTimeoutMs: [1000, 60000],
  circuitBreakerMaxFailures: [1, 20],
  searchTimeoutMs: [1000, 120000],
  cacheTtlMinutes: [1, 10],
  searchRateLimitWindowSeconds: [10, 3600],
  searchRateLimitPerSession: [1, 300],
  searchRateLimitPerIp: [1, 1000],
};

const legacyPolicyKeys = [
  "customChannelsEnabled",
  "loginSessionDays",
  "anonymousSessionDays",
  "loggedChannelLimit",
  "anonymousChannelLimit",
  "searchWindowSeconds",
  "anonymousSearchLimit",
  "loggedSearchLimit",
  "globalSearchLimit",
  "searchLimitPerMinute",
  "anonymousConcurrent",
  "loggedConcurrent",
  "globalConcurrent",
  "channelValidationLimit",
  "channelValidationWindowSeconds",
  "channelValidationConcurrent",
  "logRetentionDays",
] as const;

function parseValue(key: string, value: unknown, fallback: unknown): unknown {
  if (key === "registrationEnabled" || key === "showAuthButtons" || key === "anonymousCustomChannels") {
    return typeof value === "boolean" ? value : fallback;
  }
  const range = integerRanges[key];
  if (!range) return fallback;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n >= range[0] && n <= range[1] ? n : fallback;
}

function readStoredValues(): Record<string, unknown> {
  const rows = getSqliteDatabase().allRows<{ key: string; value_json: string }>("SELECT key,value_json FROM policy_settings");
  const values: Record<string, unknown> = {};
  for (const row of rows) {
    try { values[row.key] = JSON.parse(row.value_json); } catch { /* use default */ }
  }
  return values;
}

/**
 * Previous releases kept performance values in system_settings/search_settings.
 * Read them only as a migration fallback; all new writes go to policy_settings.
 */
function readLegacyPerformanceValues(): Record<string, unknown> {
  const db = getSqliteDatabase();
  const system = db.getRow<{ default_concurrency: number; request_timeout_ms: number; cache_ttl_minutes: number }>(
    "SELECT default_concurrency,request_timeout_ms,cache_ttl_minutes FROM system_settings WHERE id=1",
  );
  const search = db.getRow<{ concurrency: number | null }>("SELECT concurrency FROM search_settings WHERE id=1");
  return {
    // An explicitly configured search_settings concurrency took precedence over
    // the old system default in the previous resource settings dialog.
    defaultConcurrency: search?.concurrency ?? system?.default_concurrency,
    requestTimeoutMs: system?.request_timeout_ms,
    cacheTtlMinutes: system?.cache_ttl_minutes,
  };
}

function persistMigratedValues(values: Record<string, unknown>, result: UserPolicy): void {
  const keys = ["showAuthButtons", "defaultConcurrency", "requestTimeoutMs", "circuitBreakerMaxFailures", "searchTimeoutMs", "cacheTtlMinutes", "searchRateLimitWindowSeconds", "searchRateLimitPerSession", "searchRateLimitPerIp"] as const;
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(values, key));
  const hasLegacy = legacyPolicyKeys.some((key) => Object.prototype.hasOwnProperty.call(values, key));
  if (!missing.length && !hasLegacy) return;
  const db = getSqliteDatabase();
  const timestamp = Date.now();
  db.transaction(() => {
    const stmt = "INSERT INTO policy_settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING";
    for (const key of missing) db.run(stmt, key, JSON.stringify(result[key]), timestamp);
    // The old per-site concurrency value has now been copied to policy_settings.
    // Keep the legacy column for compatibility, but prevent it from becoming a
    // second active source of truth.
    if (missing.includes("defaultConcurrency")) db.run("UPDATE search_settings SET concurrency = NULL WHERE id=1");
    if (hasLegacy) db.run(`DELETE FROM policy_settings WHERE key IN (${legacyPolicyKeys.map(() => "?").join(",")})`, ...legacyPolicyKeys);
  });
}

export function getUserPolicy(): UserPolicy {
  const values = readStoredValues();
  const legacy = readLegacyPerformanceValues();
  const result: UserPolicy = {
    registrationEnabled: parseValue("registrationEnabled", values.registrationEnabled, DEFAULT_USER_POLICY.registrationEnabled) as boolean,
    showAuthButtons: parseValue("showAuthButtons", values.showAuthButtons, DEFAULT_USER_POLICY.showAuthButtons) as boolean,
    anonymousCustomChannels: parseValue("anonymousCustomChannels", values.anonymousCustomChannels, DEFAULT_USER_POLICY.anonymousCustomChannels) as boolean,
    // Read the old names as a one-time compatibility fallback for existing installs.
    sessionDays: parseValue("sessionDays", values.sessionDays ?? values.loginSessionDays ?? values.anonymousSessionDays, DEFAULT_USER_POLICY.sessionDays) as number,
    customChannelLimit: parseValue("customChannelLimit", values.customChannelLimit ?? values.loggedChannelLimit ?? values.anonymousChannelLimit, DEFAULT_USER_POLICY.customChannelLimit) as number,
    defaultConcurrency: parseValue("defaultConcurrency", values.defaultConcurrency ?? legacy.defaultConcurrency, DEFAULT_USER_POLICY.defaultConcurrency) as number,
    requestTimeoutMs: parseValue("requestTimeoutMs", values.requestTimeoutMs ?? legacy.requestTimeoutMs, DEFAULT_USER_POLICY.requestTimeoutMs) as number,
    circuitBreakerMaxFailures: parseValue("circuitBreakerMaxFailures", values.circuitBreakerMaxFailures, DEFAULT_USER_POLICY.circuitBreakerMaxFailures) as number,
    searchTimeoutMs: parseValue("searchTimeoutMs", values.searchTimeoutMs, DEFAULT_USER_POLICY.searchTimeoutMs) as number,
    cacheTtlMinutes: parseValue("cacheTtlMinutes", values.cacheTtlMinutes ?? legacy.cacheTtlMinutes, DEFAULT_USER_POLICY.cacheTtlMinutes) as number,
    searchRateLimitWindowSeconds: parseValue("searchRateLimitWindowSeconds", values.searchRateLimitWindowSeconds, DEFAULT_USER_POLICY.searchRateLimitWindowSeconds) as number,
    searchRateLimitPerSession: parseValue("searchRateLimitPerSession", values.searchRateLimitPerSession, DEFAULT_USER_POLICY.searchRateLimitPerSession) as number,
    searchRateLimitPerIp: parseValue("searchRateLimitPerIp", values.searchRateLimitPerIp, DEFAULT_USER_POLICY.searchRateLimitPerIp) as number,
  };
  persistMigratedValues(values, result);
  return result;
}

export function saveUserPolicy(input: Partial<UserPolicy>): UserPolicy {
  const current = getUserPolicy();
  const inputKeys = Object.keys(input as object);
  const allowedKeys = new Set(Object.keys(DEFAULT_USER_POLICY));
  const unknownKey = inputKeys.find((key) => !allowedKeys.has(key));
  if (unknownKey) throw new Error(`不支持的策略项: ${unknownKey}`);

  const next: UserPolicy = {
    registrationEnabled: parseValue("registrationEnabled", Object.prototype.hasOwnProperty.call(input, "registrationEnabled") ? input.registrationEnabled : current.registrationEnabled, undefined) as boolean,
    showAuthButtons: parseValue("showAuthButtons", Object.prototype.hasOwnProperty.call(input, "showAuthButtons") ? input.showAuthButtons : current.showAuthButtons, undefined) as boolean,
    anonymousCustomChannels: parseValue("anonymousCustomChannels", Object.prototype.hasOwnProperty.call(input, "anonymousCustomChannels") ? input.anonymousCustomChannels : current.anonymousCustomChannels, undefined) as boolean,
    sessionDays: parseValue("sessionDays", Object.prototype.hasOwnProperty.call(input, "sessionDays") ? input.sessionDays : current.sessionDays, undefined) as number,
    customChannelLimit: parseValue("customChannelLimit", Object.prototype.hasOwnProperty.call(input, "customChannelLimit") ? input.customChannelLimit : current.customChannelLimit, undefined) as number,
    defaultConcurrency: parseValue("defaultConcurrency", Object.prototype.hasOwnProperty.call(input, "defaultConcurrency") ? input.defaultConcurrency : current.defaultConcurrency, undefined) as number,
    requestTimeoutMs: parseValue("requestTimeoutMs", Object.prototype.hasOwnProperty.call(input, "requestTimeoutMs") ? input.requestTimeoutMs : current.requestTimeoutMs, undefined) as number,
    circuitBreakerMaxFailures: parseValue("circuitBreakerMaxFailures", Object.prototype.hasOwnProperty.call(input, "circuitBreakerMaxFailures") ? input.circuitBreakerMaxFailures : current.circuitBreakerMaxFailures, undefined) as number,
    searchTimeoutMs: parseValue("searchTimeoutMs", Object.prototype.hasOwnProperty.call(input, "searchTimeoutMs") ? input.searchTimeoutMs : current.searchTimeoutMs, undefined) as number,
    cacheTtlMinutes: parseValue("cacheTtlMinutes", Object.prototype.hasOwnProperty.call(input, "cacheTtlMinutes") ? input.cacheTtlMinutes : current.cacheTtlMinutes, undefined) as number,
    searchRateLimitWindowSeconds: parseValue("searchRateLimitWindowSeconds", Object.prototype.hasOwnProperty.call(input, "searchRateLimitWindowSeconds") ? input.searchRateLimitWindowSeconds : current.searchRateLimitWindowSeconds, undefined) as number,
    searchRateLimitPerSession: parseValue("searchRateLimitPerSession", Object.prototype.hasOwnProperty.call(input, "searchRateLimitPerSession") ? input.searchRateLimitPerSession : current.searchRateLimitPerSession, undefined) as number,
    searchRateLimitPerIp: parseValue("searchRateLimitPerIp", Object.prototype.hasOwnProperty.call(input, "searchRateLimitPerIp") ? input.searchRateLimitPerIp : current.searchRateLimitPerIp, undefined) as number,
  };
  if (Object.values(next).some((value) => value === undefined)) throw new Error("策略配置项无效");

  const db = getSqliteDatabase();
  const now = Date.now();
  db.transaction(() => {
    const stmt = "INSERT INTO policy_settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at";
    for (const key of Object.keys(next) as Array<keyof UserPolicy>) db.run(stmt, key, JSON.stringify(next[key]), now);
    // Remove settings from the former, larger policy surface so the database and API stay in sync.
    db.run(`DELETE FROM policy_settings WHERE key IN (${legacyPolicyKeys.map(() => "?").join(",")})`, ...legacyPolicyKeys);
    // The legacy columns remain for old databases, but are no longer read by
    // runtime code after policy_settings has been populated.
    db.run("UPDATE search_settings SET concurrency = NULL WHERE id=1");
  });
  return next;
}

const SEARCH_LOG_RETENTION_DAYS = 90;

export function cleanupUserData(now = Date.now()): void {
  const db = getSqliteDatabase();
  db.run("DELETE FROM sessions WHERE expires_at <= ?", now);
  db.run("DELETE FROM search_logs WHERE created_at < ?", now - SEARCH_LOG_RETENTION_DAYS * 86400000);
}
