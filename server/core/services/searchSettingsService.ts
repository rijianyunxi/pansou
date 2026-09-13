import { normalizeTelegramChannels, TG_CHANNEL_PATTERN } from "../../../utils/telegramChannels";
import { getSqliteDatabase } from "../storage/sqlite";

export interface SearchSettings { plugins: string[] | null; channels: string[] | null; concurrency: number | null; pluginTimeoutMs: number | null; trashedPlugins: string[]; }
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
  const pluginTimeoutMs = typeof value.pluginTimeoutMs === "number" && value.pluginTimeoutMs >= 1000 && value.pluginTimeoutMs <= 60_000 ? Math.round(value.pluginTimeoutMs) : null;
  return { plugins, channels, concurrency, pluginTimeoutMs, trashedPlugins };
}

export function getSearchSettings(): SearchSettings {
  const db = getSqliteDatabase();
  const row = db.getRow<{ concurrency: number | null; plugin_timeout_ms: number | null; plugins_configured: number; channels_configured: number }>("SELECT concurrency,plugin_timeout_ms,plugins_configured,channels_configured FROM search_settings WHERE id=1");
  const pluginRows = db.allRows<{ plugin_id: string; trashed: number }>("SELECT plugin_id,trashed FROM search_setting_plugins ORDER BY plugin_id");
  const channelRows = db.allRows<{ channel: string }>("SELECT channel FROM search_setting_channels ORDER BY position");
  const configuredPlugins = pluginRows.filter(row => !row.trashed).map(row => row.plugin_id);
  const trashedPlugins = pluginRows.filter(row => row.trashed).map(row => row.plugin_id);
  return sanitize({ plugins: row?.plugins_configured ? configuredPlugins : null, channels: row?.channels_configured ? channelRows.map(row => row.channel) : null, concurrency: row?.concurrency ?? null, pluginTimeoutMs: row?.plugin_timeout_ms ?? null, trashedPlugins });
}
export function getSearchSettingsVersion(): string | null {
  const db = getSqliteDatabase();
  const row = db.getRow<{ updated_at: number }>("SELECT updated_at FROM search_settings WHERE id=1");
  const counts = db.getRow<{ updated_at: number }>("SELECT MAX(updated_at) AS updated_at FROM (SELECT updated_at FROM search_settings UNION ALL SELECT 0 AS updated_at)");
  return `${row?.updated_at ?? counts?.updated_at ?? 0}:${getSearchSettings().plugins?.join(",") || "*"}:${getSearchSettings().channels?.join(",") || "*"}`;
}
export function saveSearchSettings(patch: unknown): SearchSettings {
  const next = sanitize({ ...getSearchSettings(), ...((patch && typeof patch === "object") ? patch as Record<string, unknown> : {}) });
  const db = getSqliteDatabase(); const now = Date.now();
  db.transaction(() => {
    db.run("INSERT INTO search_settings(id,concurrency,plugin_timeout_ms,plugins_configured,channels_configured,updated_at) VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET concurrency=excluded.concurrency,plugin_timeout_ms=excluded.plugin_timeout_ms,plugins_configured=excluded.plugins_configured,channels_configured=excluded.channels_configured,updated_at=excluded.updated_at", next.concurrency, next.pluginTimeoutMs, next.plugins !== null ? 1 : 0, next.channels !== null ? 1 : 0, now);
    db.run("DELETE FROM search_setting_plugins");
    for (const id of [...(next.plugins || []), ...next.trashedPlugins]) db.run("INSERT INTO search_setting_plugins(plugin_id,trashed) VALUES(?,?)", id, next.trashedPlugins.includes(id) ? 1 : 0);
    db.run("DELETE FROM search_setting_channels");
    for (const [position, channel] of (next.channels || []).entries()) db.run("INSERT INTO search_setting_channels(channel,position) VALUES(?,?)", channel, position);
  });
  return clone(next);
}
export function setPluginTrashed(id: string, trashed: boolean): SearchSettings {
  const current = getSearchSettings(); const set = new Set(current.trashedPlugins); if (trashed) set.add(id); else set.delete(id); return saveSearchSettings({ trashedPlugins: [...set] });
}
