import { getSqliteDatabase } from "../storage/sqlite";
import { DEFAULT_HOME_SEARCH_PLACEHOLDER } from "../../../shared/homeSearch";

/**
 * 管理后台暴露的用户、频道和搜索运行策略。
 * 运行参数也归入这里，避免在资源源选择弹窗中分散配置。
 */
export interface UserPolicy {
  showHotSearch: boolean;
  anonymousCustomChannels: boolean;
  /** Controls the homepage sign-in entry. The entry itself is WeChat QR login. */
  showAuthButtons: boolean;
  homeSearchPlaceholder: string;
  sessionDays: number;
  customChannelLimit: number;
  defaultConcurrency: number;
  requestTimeoutMs: number;
  circuitBreakerMaxFailures: number;
  proxyCircuitBreakerMaxFailures: number;
  proxyCircuitBreakerTimeoutSeconds: number;
  searchTimeoutMs: number;
  cacheTtlMinutes: number;
  cacheMaxMemoryMb: number;
  anonymousSearchRateLimitWindowSeconds: number;
  anonymousSearchRateLimitPerSession: number;
  anonymousSearchRateLimitPerIp: number;
  loggedSearchRateLimitWindowSeconds: number;
  loggedSearchRateLimitPerSession: number;
  loggedSearchRateLimitPerIp: number;
}

export const DEFAULT_USER_POLICY: UserPolicy = {
  showHotSearch: true,
  anonymousCustomChannels: false,
  showAuthButtons: true,
  homeSearchPlaceholder: DEFAULT_HOME_SEARCH_PLACEHOLDER,
  sessionDays: 30,
  customChannelLimit: 10,
  defaultConcurrency: 4,
  requestTimeoutMs: 5000,
  circuitBreakerMaxFailures: 5,
  proxyCircuitBreakerMaxFailures: 3,
  proxyCircuitBreakerTimeoutSeconds: 300,
  searchTimeoutMs: 30000,
  cacheTtlMinutes: 10,
  cacheMaxMemoryMb: 100,
  anonymousSearchRateLimitWindowSeconds: 60,
  anonymousSearchRateLimitPerSession: 20,
  anonymousSearchRateLimitPerIp: 60,
  loggedSearchRateLimitWindowSeconds: 60,
  loggedSearchRateLimitPerSession: 60,
  loggedSearchRateLimitPerIp: 240,
};

const integerRanges: Record<string, [number, number]> = {
  sessionDays: [1, 365],
  customChannelLimit: [0, 100],
  defaultConcurrency: [1, 16],
  requestTimeoutMs: [1000, 60000],
  circuitBreakerMaxFailures: [1, 20],
  proxyCircuitBreakerMaxFailures: [1, 20],
  proxyCircuitBreakerTimeoutSeconds: [10, 3600],
  searchTimeoutMs: [1000, 120000],
  cacheTtlMinutes: [1, 10],
  cacheMaxMemoryMb: [16, 512],
  anonymousSearchRateLimitWindowSeconds: [10, 3600],
  anonymousSearchRateLimitPerSession: [1, 300],
  anonymousSearchRateLimitPerIp: [1, 1000],
  loggedSearchRateLimitWindowSeconds: [10, 3600],
  loggedSearchRateLimitPerSession: [1, 300],
  loggedSearchRateLimitPerIp: [1, 1000],
};

const legacyPolicyKeys = [
  "customChannelsEnabled",
  "loginSessionDays",
  "anonymousSessionDays",
  "loggedChannelLimit",
  "anonymousChannelLimit",
  "anonymousConcurrent",
  "loggedConcurrent",
  "globalConcurrent",
  "channelValidationLimit",
  "channelValidationWindowSeconds",
  "channelValidationConcurrent",
  "logRetentionDays",
] as const;

function parseValue(key: string, value: unknown, fallback: unknown): unknown {
  if (key === "homeSearchPlaceholder") {
    const text = typeof value === "string" ? value.trim() : "";
    return text.length >= 1 && text.length <= 120 ? text : fallback;
  }
  if (key === "showHotSearch" || key === "anonymousCustomChannels" || key === "showAuthButtons") {
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
  const keys = ["showHotSearch", "showAuthButtons", "homeSearchPlaceholder", "defaultConcurrency", "requestTimeoutMs", "circuitBreakerMaxFailures", "proxyCircuitBreakerMaxFailures", "proxyCircuitBreakerTimeoutSeconds", "searchTimeoutMs", "cacheTtlMinutes", "cacheMaxMemoryMb", "anonymousSearchRateLimitWindowSeconds", "anonymousSearchRateLimitPerSession", "anonymousSearchRateLimitPerIp", "loggedSearchRateLimitWindowSeconds", "loggedSearchRateLimitPerSession", "loggedSearchRateLimitPerIp"] as const;
  const obsoleteKeys = ["cacheMaxEntries"] as const;
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(values, key));
  const hasLegacy = legacyPolicyKeys.some((key) => Object.prototype.hasOwnProperty.call(values, key));
  const hasObsolete = obsoleteKeys.some((key) => Object.prototype.hasOwnProperty.call(values, key));
  if (!missing.length && !hasLegacy && !hasObsolete) return;
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
    if (hasObsolete) db.run(`DELETE FROM policy_settings WHERE key IN (${obsoleteKeys.map(() => "?").join(",")})`, ...obsoleteKeys);
  });
}

export function getUserPolicy(): UserPolicy {
  const values = readStoredValues();
  const legacy = readLegacyPerformanceValues();
  const result: UserPolicy = {
    showHotSearch: parseValue("showHotSearch", values.showHotSearch, DEFAULT_USER_POLICY.showHotSearch) as boolean,
    anonymousCustomChannels: parseValue("anonymousCustomChannels", values.anonymousCustomChannels, DEFAULT_USER_POLICY.anonymousCustomChannels) as boolean,
    showAuthButtons: parseValue("showAuthButtons", values.showAuthButtons, DEFAULT_USER_POLICY.showAuthButtons) as boolean,
    homeSearchPlaceholder: parseValue("homeSearchPlaceholder", values.homeSearchPlaceholder, DEFAULT_USER_POLICY.homeSearchPlaceholder) as string,
    // Read the old names as a one-time compatibility fallback for existing installs.
    sessionDays: parseValue("sessionDays", values.sessionDays ?? values.loginSessionDays ?? values.anonymousSessionDays, DEFAULT_USER_POLICY.sessionDays) as number,
    customChannelLimit: parseValue("customChannelLimit", values.customChannelLimit ?? values.loggedChannelLimit ?? values.anonymousChannelLimit, DEFAULT_USER_POLICY.customChannelLimit) as number,
    defaultConcurrency: parseValue("defaultConcurrency", values.defaultConcurrency ?? legacy.defaultConcurrency, DEFAULT_USER_POLICY.defaultConcurrency) as number,
    requestTimeoutMs: parseValue("requestTimeoutMs", values.requestTimeoutMs ?? legacy.requestTimeoutMs, DEFAULT_USER_POLICY.requestTimeoutMs) as number,
    circuitBreakerMaxFailures: parseValue("circuitBreakerMaxFailures", values.circuitBreakerMaxFailures, DEFAULT_USER_POLICY.circuitBreakerMaxFailures) as number,
    proxyCircuitBreakerMaxFailures: parseValue("proxyCircuitBreakerMaxFailures", values.proxyCircuitBreakerMaxFailures, DEFAULT_USER_POLICY.proxyCircuitBreakerMaxFailures) as number,
    proxyCircuitBreakerTimeoutSeconds: parseValue("proxyCircuitBreakerTimeoutSeconds", values.proxyCircuitBreakerTimeoutSeconds, DEFAULT_USER_POLICY.proxyCircuitBreakerTimeoutSeconds) as number,
    searchTimeoutMs: parseValue("searchTimeoutMs", values.searchTimeoutMs, DEFAULT_USER_POLICY.searchTimeoutMs) as number,
    cacheTtlMinutes: parseValue("cacheTtlMinutes", values.cacheTtlMinutes ?? legacy.cacheTtlMinutes, DEFAULT_USER_POLICY.cacheTtlMinutes) as number,
    cacheMaxMemoryMb: parseValue("cacheMaxMemoryMb", values.cacheMaxMemoryMb, DEFAULT_USER_POLICY.cacheMaxMemoryMb) as number,
    anonymousSearchRateLimitWindowSeconds: parseValue("anonymousSearchRateLimitWindowSeconds", values.anonymousSearchRateLimitWindowSeconds, DEFAULT_USER_POLICY.anonymousSearchRateLimitWindowSeconds) as number,
    anonymousSearchRateLimitPerSession: parseValue("anonymousSearchRateLimitPerSession", values.anonymousSearchRateLimitPerSession, DEFAULT_USER_POLICY.anonymousSearchRateLimitPerSession) as number,
    anonymousSearchRateLimitPerIp: parseValue("anonymousSearchRateLimitPerIp", values.anonymousSearchRateLimitPerIp, DEFAULT_USER_POLICY.anonymousSearchRateLimitPerIp) as number,
    loggedSearchRateLimitWindowSeconds: parseValue("loggedSearchRateLimitWindowSeconds", values.loggedSearchRateLimitWindowSeconds, DEFAULT_USER_POLICY.loggedSearchRateLimitWindowSeconds) as number,
    loggedSearchRateLimitPerSession: parseValue("loggedSearchRateLimitPerSession", values.loggedSearchRateLimitPerSession, DEFAULT_USER_POLICY.loggedSearchRateLimitPerSession) as number,
    loggedSearchRateLimitPerIp: parseValue("loggedSearchRateLimitPerIp", values.loggedSearchRateLimitPerIp, DEFAULT_USER_POLICY.loggedSearchRateLimitPerIp) as number,
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
    showHotSearch: parseValue("showHotSearch", Object.prototype.hasOwnProperty.call(input, "showHotSearch") ? input.showHotSearch : current.showHotSearch, undefined) as boolean,
    anonymousCustomChannels: parseValue("anonymousCustomChannels", Object.prototype.hasOwnProperty.call(input, "anonymousCustomChannels") ? input.anonymousCustomChannels : current.anonymousCustomChannels, undefined) as boolean,
    showAuthButtons: parseValue("showAuthButtons", Object.prototype.hasOwnProperty.call(input, "showAuthButtons") ? input.showAuthButtons : current.showAuthButtons, undefined) as boolean,
    homeSearchPlaceholder: parseValue("homeSearchPlaceholder", Object.prototype.hasOwnProperty.call(input, "homeSearchPlaceholder") ? input.homeSearchPlaceholder : current.homeSearchPlaceholder, undefined) as string,
    sessionDays: parseValue("sessionDays", Object.prototype.hasOwnProperty.call(input, "sessionDays") ? input.sessionDays : current.sessionDays, undefined) as number,
    customChannelLimit: parseValue("customChannelLimit", Object.prototype.hasOwnProperty.call(input, "customChannelLimit") ? input.customChannelLimit : current.customChannelLimit, undefined) as number,
    defaultConcurrency: parseValue("defaultConcurrency", Object.prototype.hasOwnProperty.call(input, "defaultConcurrency") ? input.defaultConcurrency : current.defaultConcurrency, undefined) as number,
    requestTimeoutMs: parseValue("requestTimeoutMs", Object.prototype.hasOwnProperty.call(input, "requestTimeoutMs") ? input.requestTimeoutMs : current.requestTimeoutMs, undefined) as number,
    circuitBreakerMaxFailures: parseValue("circuitBreakerMaxFailures", Object.prototype.hasOwnProperty.call(input, "circuitBreakerMaxFailures") ? input.circuitBreakerMaxFailures : current.circuitBreakerMaxFailures, undefined) as number,
    proxyCircuitBreakerMaxFailures: parseValue("proxyCircuitBreakerMaxFailures", Object.prototype.hasOwnProperty.call(input, "proxyCircuitBreakerMaxFailures") ? input.proxyCircuitBreakerMaxFailures : current.proxyCircuitBreakerMaxFailures, undefined) as number,
    proxyCircuitBreakerTimeoutSeconds: parseValue("proxyCircuitBreakerTimeoutSeconds", Object.prototype.hasOwnProperty.call(input, "proxyCircuitBreakerTimeoutSeconds") ? input.proxyCircuitBreakerTimeoutSeconds : current.proxyCircuitBreakerTimeoutSeconds, undefined) as number,
    searchTimeoutMs: parseValue("searchTimeoutMs", Object.prototype.hasOwnProperty.call(input, "searchTimeoutMs") ? input.searchTimeoutMs : current.searchTimeoutMs, undefined) as number,
    cacheTtlMinutes: parseValue("cacheTtlMinutes", Object.prototype.hasOwnProperty.call(input, "cacheTtlMinutes") ? input.cacheTtlMinutes : current.cacheTtlMinutes, undefined) as number,
    cacheMaxMemoryMb: parseValue("cacheMaxMemoryMb", Object.prototype.hasOwnProperty.call(input, "cacheMaxMemoryMb") ? input.cacheMaxMemoryMb : current.cacheMaxMemoryMb, undefined) as number,
    anonymousSearchRateLimitWindowSeconds: parseValue("anonymousSearchRateLimitWindowSeconds", Object.prototype.hasOwnProperty.call(input, "anonymousSearchRateLimitWindowSeconds") ? input.anonymousSearchRateLimitWindowSeconds : current.anonymousSearchRateLimitWindowSeconds, undefined) as number,
    anonymousSearchRateLimitPerSession: parseValue("anonymousSearchRateLimitPerSession", Object.prototype.hasOwnProperty.call(input, "anonymousSearchRateLimitPerSession") ? input.anonymousSearchRateLimitPerSession : current.anonymousSearchRateLimitPerSession, undefined) as number,
    anonymousSearchRateLimitPerIp: parseValue("anonymousSearchRateLimitPerIp", Object.prototype.hasOwnProperty.call(input, "anonymousSearchRateLimitPerIp") ? input.anonymousSearchRateLimitPerIp : current.anonymousSearchRateLimitPerIp, undefined) as number,
    loggedSearchRateLimitWindowSeconds: parseValue("loggedSearchRateLimitWindowSeconds", Object.prototype.hasOwnProperty.call(input, "loggedSearchRateLimitWindowSeconds") ? input.loggedSearchRateLimitWindowSeconds : current.loggedSearchRateLimitWindowSeconds, undefined) as number,
    loggedSearchRateLimitPerSession: parseValue("loggedSearchRateLimitPerSession", Object.prototype.hasOwnProperty.call(input, "loggedSearchRateLimitPerSession") ? input.loggedSearchRateLimitPerSession : current.loggedSearchRateLimitPerSession, undefined) as number,
    loggedSearchRateLimitPerIp: parseValue("loggedSearchRateLimitPerIp", Object.prototype.hasOwnProperty.call(input, "loggedSearchRateLimitPerIp") ? input.loggedSearchRateLimitPerIp : current.loggedSearchRateLimitPerIp, undefined) as number,
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
