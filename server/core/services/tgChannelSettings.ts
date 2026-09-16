import { sanitizeChannelStates, type TgChannelStateEntry, type TgChannelStateMap } from "../../utils/telegramSettings";
import { TG_CHANNEL_PATTERN, normalizeTelegramChannels } from "../../../utils/telegramChannels";
import { getSqliteDatabase } from "../storage/sqlite";

function normalize(value: unknown): string { return String(value || "").trim().replace(/^@/, "").toLowerCase(); }
function readStates(): TgChannelStateMap {
  const db = getSqliteDatabase();
  return sanitizeChannelStates(Object.fromEntries(db.allRows<any>("SELECT channel,enabled,deleted FROM tg_channel_states ORDER BY channel").map((row) => [row.channel, { enabled: Boolean(row.enabled), deleted: Boolean(row.deleted) }])));
}
export function getTgChannelStates(): TgChannelStateMap { return structuredClone(readStates()); }
export function getTgChannelState(channel: string): TgChannelStateEntry | undefined { return getTgChannelStates()[normalize(channel)]; }
export function setTgChannelState(channel: string, patch: { enabled?: boolean; deleted?: boolean }): TgChannelStateEntry {
  const name = normalize(channel);
  if (!TG_CHANNEL_PATTERN.test(name)) throw new Error(`invalid channel username: ${String(channel).slice(0, 64)}`);
  const current = getTgChannelState(name) || { enabled: true, deleted: false };
  const next = { enabled: patch.enabled ?? current.enabled, deleted: patch.deleted ?? current.deleted };
  const db = getSqliteDatabase();
  db.run("INSERT INTO tg_channel_states(channel,enabled,deleted,updated_at) VALUES(?,?,?,?) ON CONFLICT(channel) DO UPDATE SET enabled=excluded.enabled,deleted=excluded.deleted,updated_at=excluded.updated_at", name, next.enabled ? 1 : 0, next.deleted ? 1 : 0, Date.now());
  if (next.enabled && !next.deleted) db.run("DELETE FROM tg_channel_states WHERE channel=?", name);
  return next;
}
export function clearTgChannelState(channel: string): void { getSqliteDatabase().run("DELETE FROM tg_channel_states WHERE channel=?", normalize(channel)); }
export function countEffectiveTgChannels(channels: string[]): number { const states = getTgChannelStates(); return normalizeTelegramChannels(channels).filter((name) => !states[name]?.deleted && states[name]?.enabled !== false).length; }
export function getTgChannelSettingsVersion(): string { const row = getSqliteDatabase().getRow<{ updated_at: number }>("SELECT MAX(updated_at) AS updated_at FROM tg_channel_states"); return String(row?.updated_at || 0); }
export interface PurgedTgChannel { channel: string; removedSystemEntries: number; removedSearchEntries: number; removedHealthRecords: number; }
export function purgeTgChannel(channel: string): PurgedTgChannel {
  const name = normalize(channel);
  if (!TG_CHANNEL_PATTERN.test(name)) throw new Error(`invalid channel username: ${String(channel).slice(0, 64)}`);
  const db = getSqliteDatabase();
  const archived = db.getRow<{ deleted: number }>("SELECT deleted FROM tg_channel_states WHERE channel=?", name);
  if (!archived?.deleted) throw new Error("Telegram channel must be archived before permanent deletion");
  const result = db.transaction(() => {
    const removedSystemEntries = db.run("DELETE FROM system_channels WHERE name=?", name).changes;
    const removedSearchEntries = db.run("DELETE FROM search_setting_channels WHERE channel=?", name).changes;
    // Health is stored by the unified SourceHealthChecker for every resource source.
    const removedHealthRecords = db.run("DELETE FROM source_health WHERE source_id=?", name).changes;
    db.run("DELETE FROM resource_sources WHERE id=?", name);
    db.run("DELETE FROM deleted_sources WHERE id=?", name);
    db.run("DELETE FROM tg_channel_states WHERE channel=?", name);
    return { removedSystemEntries, removedSearchEntries, removedHealthRecords };
  });
  return { channel: name, ...result };
}
export function filterEffectiveTgChannels(channels: string[]): string[] { const states = getTgChannelStates(); return normalizeTelegramChannels(channels).filter((name) => !states[name]?.deleted && states[name]?.enabled !== false); }
export function countEffectiveTgChannelsLegacy(channels: string[]): number { return filterEffectiveTgChannels(channels).length; }
