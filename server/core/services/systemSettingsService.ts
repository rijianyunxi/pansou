import { getSqliteDatabase } from "../storage/sqlite";
import { normalizeTelegramChannels } from "../../../utils/telegramChannels";

export interface SystemSettingsSeed {
  priorityChannels: string[];
  defaultChannels: string[];
  defaultConcurrency: number;
  pluginTimeoutMs: number;
  cacheTtlMinutes: number;
}
const NAMESPACE = "system_settings";
const KEY = "seed";

/**
 * Runtime defaults are seeded from nuxt.config on first boot, then read from
 * SQLite. This keeps admin-managed state durable while retaining the checked-in
 * config as a recoverable bootstrap source.
 */
export function getSystemSettings(fallback: Partial<SystemSettingsSeed>): SystemSettingsSeed {
  const current = getSqliteDatabase().get<SystemSettingsSeed | null>(NAMESPACE, KEY, null);
  if (current) return current;
  const seed: SystemSettingsSeed = {
    priorityChannels: normalizeTelegramChannels(fallback.priorityChannels || []),
    defaultChannels: normalizeTelegramChannels(fallback.defaultChannels || []),
    defaultConcurrency: Number(fallback.defaultConcurrency) || 10,
    pluginTimeoutMs: Number(fallback.pluginTimeoutMs) || 15000,
    cacheTtlMinutes: Number(fallback.cacheTtlMinutes) || 30,
  };
  getSqliteDatabase().set(NAMESPACE, KEY, seed);
  return seed;
}

export function saveSystemSettings(patch: Partial<SystemSettingsSeed>): SystemSettingsSeed {
  const next = getSystemSettings(patch);
  const value: SystemSettingsSeed = {
    ...next,
    ...(patch.priorityChannels ? { priorityChannels: normalizeTelegramChannels(patch.priorityChannels) } : {}),
    ...(patch.defaultChannels ? { defaultChannels: normalizeTelegramChannels(patch.defaultChannels) } : {}),
    ...(patch.defaultConcurrency !== undefined ? { defaultConcurrency: Number(patch.defaultConcurrency) } : {}),
    ...(patch.pluginTimeoutMs !== undefined ? { pluginTimeoutMs: Number(patch.pluginTimeoutMs) } : {}),
    ...(patch.cacheTtlMinutes !== undefined ? { cacheTtlMinutes: Number(patch.cacheTtlMinutes) } : {}),
  };
  getSqliteDatabase().set(NAMESPACE, KEY, value);
  return value;
}
