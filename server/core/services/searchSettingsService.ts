import { normalizeTelegramChannels, TG_CHANNEL_PATTERN } from "../../../utils/telegramChannels";
import { getSqliteDatabase } from "../storage/sqlite";
import { getSystemSettings } from "./systemSettingsService";

export interface SearchSettings { sources: string[] | null; channels: string[] | null; concurrency: number | null; /** Derived from system_settings; never stored here. */ requestTimeoutMs: number; trashedSources: string[]; }
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
  const sources = strList(value.sources, s => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(s));
  const rawChannels = strList(value.channels);
  const channels = rawChannels === null ? null : normalizeTelegramChannels(rawChannels).filter(name => TG_CHANNEL_PATTERN.test(name)).slice(0, MAX_CHANNELS);
  const trashedSources = strList(value.trashedSources, s => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(s)) || [];
  const concurrency = typeof value.concurrency === "number" && value.concurrency >= 1 && value.concurrency <= 16 ? Math.round(value.concurrency) : null;
  return { sources, channels, concurrency, requestTimeoutMs: getSystemSettings().requestTimeoutMs, trashedSources };
}

export function getSearchSettings(): SearchSettings {
  const db = getSqliteDatabase();
  const row = db.getRow<{ concurrency: number | null; sources_configured: number; channels_configured: number }>("SELECT concurrency,sources_configured,channels_configured FROM search_settings WHERE id=1");
  const sourceRows = db.allRows<{ source_id: string; trashed: number }>("SELECT source_id,trashed FROM search_setting_sources ORDER BY source_id");
  const channelRows = db.allRows<{ channel: string }>("SELECT channel FROM search_setting_channels ORDER BY position");
  const configuredSources = sourceRows.filter(row => !row.trashed).map(row => row.source_id);
  const trashedSources = sourceRows.filter(row => row.trashed).map(row => row.source_id);
  return sanitize({ sources: row?.sources_configured ? configuredSources : null, channels: row?.channels_configured ? channelRows.map(row => row.channel) : null, concurrency: row?.concurrency ?? null, trashedSources });
}
export function getSearchSettingsVersion(): string | null {
  const db = getSqliteDatabase();
  const row = db.getRow<{ updated_at: number }>("SELECT updated_at FROM search_settings WHERE id=1");
  const system = db.getRow<{ updated_at: number }>("SELECT updated_at FROM system_settings WHERE id=1");
  const updatedAt = Math.max(row?.updated_at ?? 0, system?.updated_at ?? 0);
  return `${updatedAt}:${getSearchSettings().sources?.join(",") || "*"}:${getSearchSettings().channels?.join(",") || "*"}`;
}
/**
 * Keep the monitor's source enabled state and an explicit source selection in
 * sync. When sources is null, the selection means "all enabled sources" and
 * the source catalog remains the single source of truth.
 */
export function setSearchSourceEnabled(id: string, enabled: boolean): SearchSettings {
  const normalizedId = String(id || "").trim();
  if (!normalizedId) return getSearchSettings();
  const current = getSearchSettings();
  if (current.sources === null) return current;
  const sources = new Set(current.sources);
  if (enabled) sources.add(normalizedId);
  else sources.delete(normalizedId);
  return saveSearchSettings({ sources: [...sources] });
}

export function saveSearchSettings(patch: unknown): SearchSettings {
  const next = sanitize({ ...getSearchSettings(), ...((patch && typeof patch === "object") ? patch as Record<string, unknown> : {}) });
  const db = getSqliteDatabase(); const now = Date.now();
  db.transaction(() => {
    db.run("INSERT INTO search_settings(id,concurrency,sources_configured,channels_configured,updated_at) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET concurrency=excluded.concurrency,sources_configured=excluded.sources_configured,channels_configured=excluded.channels_configured,updated_at=excluded.updated_at", next.concurrency, next.sources !== null ? 1 : 0, next.channels !== null ? 1 : 0, now);
    const sourceIds = [...new Set([...(next.sources || []), ...next.trashedSources])];
    if (sourceIds.length) db.run(`DELETE FROM search_setting_sources WHERE source_id NOT IN (${sourceIds.map(() => "?").join(",")})`, ...sourceIds);
    else db.run("DELETE FROM search_setting_sources");
    for (const id of sourceIds) db.run("INSERT INTO search_setting_sources(source_id,trashed) VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET trashed=excluded.trashed", id, next.trashedSources.includes(id) ? 1 : 0);
    const channels = next.channels || [];
    if (channels.length) db.run(`DELETE FROM search_setting_channels WHERE channel NOT IN (${channels.map(() => "?").join(",")})`, ...channels);
    else db.run("DELETE FROM search_setting_channels");
    for (const [position, channel] of channels.entries()) db.run("INSERT INTO search_setting_channels(channel,position) VALUES(?,?) ON CONFLICT(channel) DO UPDATE SET position=excluded.position", channel, position);
  });
  return clone(next);
}
