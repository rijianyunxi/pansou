import { normalizeTelegramChannels, TG_CHANNEL_PATTERN } from "../../../utils/telegramChannels";
import { getSqliteDatabase } from "../storage/sqlite";
import { getSystemSettings } from "./systemSettingsService";

export interface SearchSettings { plugins: string[] | null; channels: string[] | null; concurrency: number | null; /** Derived from system_settings; never stored here. */ requestTimeoutMs: number; trashedPlugins: string[]; }
const MAX_CHANNELS = 200;
const clone = <T>(value: T): T => structuredClone(value);
function sanitize(raw: Partial<SearchSettings> | null | undefined): SearchSettings {
  const value = raw || {};
  const strList = (input: unknown, filter?: (s: string) => boolean): string[] | null => {
    if (!Array.isArray(input)) return null;
    const seen = new Set<string>(); const result: string[] = [];
    for (const item of input) { if (typeof item !== "string") continue; const name = item.trim(); if (!name || seen.has(name) || (filter && !filter(name))) continue; seen.add(name); result.push(name); }
    return result;
  };
  const plugins = strList(value.plugins, s => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(s));
  const rawChannels = strList(value.channels);
  const channels = rawChannels === null ? null : normalizeTelegramChannels(rawChannels).filter(name => TG_CHANNEL_PATTERN.test(name)).slice(0, MAX_CHANNELS);
  const trashedPlugins = strList(value.trashedPlugins, s => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(s)) || [];
  const concurrency = typeof value.concurrency === "number" && value.concurrency >= 1 && value.concurrency <= 16 ? Math.round(value.concurrency) : null;
  return { plugins, channels, concurrency, requestTimeoutMs: getSystemSettings().requestTimeoutMs, trashedPlugins };
}

export function getSearchSettings(): SearchSettings {
  const db = getSqliteDatabase();
  const row = db.getRow<{ concurrency: number | null; plugins_configured: number; channels_configured: number }>("SELECT concurrency,plugins_configured,channels_configured FROM search_settings WHERE id=1");
  const pluginRows = db.allRows<{ plugin_id: string; trashed: number }>("SELECT plugin_id,trashed FROM search_setting_plugins ORDER BY plugin_id");
  const channelRows = db.allRows<{ channel: string }>("SELECT channel FROM search_setting_channels ORDER BY position");
  const configuredPlugins = pluginRows.filter(row => !row.trashed).map(row => row.plugin_id);
  const trashedPlugins = pluginRows.filter(row => row.trashed).map(row => row.plugin_id);
  return sanitize({ plugins: row?.plugins_configured ? configuredPlugins : null, channels: row?.channels_configured ? channelRows.map(row => row.channel) : null, concurrency: row?.concurrency ?? null, trashedPlugins });
}
export function getSearchSettingsVersion(): string | null {
  const db = getSqliteDatabase();
  const row = db.getRow<{ updated_at: number }>("SELECT updated_at FROM search_settings WHERE id=1");
  const system = db.getRow<{ updated_at: number }>("SELECT updated_at FROM system_settings WHERE id=1");
  const updatedAt = Math.max(row?.updated_at ?? 0, system?.updated_at ?? 0);
  return `${updatedAt}:${getSearchSettings().plugins?.join(",") || "*"}:${getSearchSettings().channels?.join(",") || "*"}`;
}
/**
 * Keep the monitor's source enabled state and an explicit plugin selection in
 * sync. When plugins is null, the selection means "all enabled sources" and
 * the source catalog remains the single source of truth.
 */
export function setSearchPluginEnabled(id: string, enabled: boolean): SearchSettings {
  const normalizedId = String(id || "").trim();
  if (!normalizedId) return getSearchSettings();
  const current = getSearchSettings();
  if (current.plugins === null) return current;
  const plugins = new Set(current.plugins);
  if (enabled) plugins.add(normalizedId);
  else plugins.delete(normalizedId);
  return saveSearchSettings({ plugins: [...plugins] });
}

export function saveSearchSettings(patch: unknown): SearchSettings {
  const next = sanitize({ ...getSearchSettings(), ...((patch && typeof patch === "object") ? patch as Record<string, unknown> : {}) });
  const db = getSqliteDatabase(); const now = Date.now();
  db.transaction(() => {
    db.run("INSERT INTO search_settings(id,concurrency,plugins_configured,channels_configured,updated_at) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET concurrency=excluded.concurrency,plugins_configured=excluded.plugins_configured,channels_configured=excluded.channels_configured,updated_at=excluded.updated_at", next.concurrency, next.plugins !== null ? 1 : 0, next.channels !== null ? 1 : 0, now);
    const pluginIds = [...new Set([...(next.plugins || []), ...next.trashedPlugins])];
    if (pluginIds.length) db.run(`DELETE FROM search_setting_plugins WHERE plugin_id NOT IN (${pluginIds.map(() => "?").join(",")})`, ...pluginIds);
    else db.run("DELETE FROM search_setting_plugins");
    for (const id of pluginIds) db.run("INSERT INTO search_setting_plugins(plugin_id,trashed) VALUES(?,?) ON CONFLICT(plugin_id) DO UPDATE SET trashed=excluded.trashed", id, next.trashedPlugins.includes(id) ? 1 : 0);
    const channels = next.channels || [];
    if (channels.length) db.run(`DELETE FROM search_setting_channels WHERE channel NOT IN (${channels.map(() => "?").join(",")})`, ...channels);
    else db.run("DELETE FROM search_setting_channels");
    for (const [position, channel] of channels.entries()) db.run("INSERT INTO search_setting_channels(channel,position) VALUES(?,?) ON CONFLICT(channel) DO UPDATE SET position=excluded.position", channel, position);
  });
  return clone(next);
}
