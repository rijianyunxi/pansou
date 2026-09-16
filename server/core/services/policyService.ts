import { getSqliteDatabase } from "../storage/sqlite";

export interface UserPolicy {
  registrationEnabled: boolean;
  customChannelsEnabled: boolean;
  anonymousCustomChannels: boolean;
  loginSessionDays: number;
  anonymousSessionDays: number;
  loggedChannelLimit: number;
  anonymousChannelLimit: number;
  searchWindowSeconds: number;
  anonymousSearchLimit: number;
  loggedSearchLimit: number;
  globalSearchLimit: number;
  anonymousConcurrent: number;
  loggedConcurrent: number;
  globalConcurrent: number;
  channelValidationLimit: number;
  channelValidationWindowSeconds: number;
  channelValidationConcurrent: number;
  logRetentionDays: number;
}

export const DEFAULT_USER_POLICY: UserPolicy = {
  registrationEnabled: true,
  customChannelsEnabled: true,
  anonymousCustomChannels: false,
  loginSessionDays: 30,
  anonymousSessionDays: 30,
  loggedChannelLimit: 10,
  anonymousChannelLimit: 3,
  searchWindowSeconds: 60,
  anonymousSearchLimit: 10,
  loggedSearchLimit: 30,
  globalSearchLimit: 120,
  anonymousConcurrent: 1,
  loggedConcurrent: 2,
  globalConcurrent: 16,
  channelValidationLimit: 12,
  channelValidationWindowSeconds: 60,
  channelValidationConcurrent: 4,
  logRetentionDays: 90,
};

const integerRanges: Record<string, [number, number]> = {
  loginSessionDays: [1, 365], anonymousSessionDays: [1, 365], loggedChannelLimit: [0, 100],
  anonymousChannelLimit: [0, 100], searchWindowSeconds: [1, 3600], anonymousSearchLimit: [1, 10000],
  loggedSearchLimit: [1, 10000], globalSearchLimit: [1, 100000], anonymousConcurrent: [1, 32],
  loggedConcurrent: [1, 32], globalConcurrent: [1, 256], channelValidationLimit: [1, 1000],
  channelValidationWindowSeconds: [1, 3600], channelValidationConcurrent: [1, 64], logRetentionDays: [1, 3650],
};

function parseValue(key: string, value: unknown, fallback: unknown): unknown {
  if (key === "registrationEnabled" || key === "customChannelsEnabled" || key === "anonymousCustomChannels") {
    return typeof value === "boolean" ? value : fallback;
  }
  const range = integerRanges[key];
  if (!range) return fallback;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n >= range[0] && n <= range[1] ? n : fallback;
}

export function getUserPolicy(): UserPolicy {
  const db = getSqliteDatabase();
  const rows = db.allRows<{ key: string; value_json: string }>("SELECT key,value_json FROM policy_settings");
  const values: Record<string, unknown> = {};
  for (const row of rows) {
    try { values[row.key] = JSON.parse(row.value_json); } catch { /* use default */ }
  }
  const result = {} as UserPolicy;
  for (const key of Object.keys(DEFAULT_USER_POLICY) as Array<keyof UserPolicy>) {
    result[key] = parseValue(key, values[key], DEFAULT_USER_POLICY[key]) as never;
  }
  return result;
}

export function saveUserPolicy(input: Partial<UserPolicy>): UserPolicy {
  const current = getUserPolicy();
  const next = {} as UserPolicy;
  for (const key of Object.keys(DEFAULT_USER_POLICY) as Array<keyof UserPolicy>) {
    const candidate = Object.prototype.hasOwnProperty.call(input, key) ? input[key] : current[key];
    const parsed = parseValue(key, candidate, undefined);
    if (parsed === undefined) throw new Error(`invalid policy value: ${key}`);
    next[key] = parsed as never;
  }
  const db = getSqliteDatabase();
  const now = Date.now();
  db.transaction(() => {
    const stmt = "INSERT INTO policy_settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at";
    for (const key of Object.keys(next) as Array<keyof UserPolicy>) db.run(stmt, key, JSON.stringify(next[key]), now);
  });
  return next;
}

export function cleanupUserData(now = Date.now()): void {
  const db = getSqliteDatabase();
  const policy = getUserPolicy();
  db.run("DELETE FROM sessions WHERE expires_at <= ?", now);
  db.run("DELETE FROM search_logs WHERE created_at < ?", now - policy.logRetentionDays * 86400000);
}
