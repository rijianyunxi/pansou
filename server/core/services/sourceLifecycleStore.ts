import {
  sanitizeSourceLifecycleStates,
  type SourceLifecycleEntry,
  type SourceLifecycleMap,
} from "../../utils/sourceLifecycle";
import { CHANNEL_NAME_PATTERN, normalizeChannelNames } from "../../../utils/customChannels";
import { getSqliteDatabase } from "../storage/sqlite";

/**
 * Persisted lifecycle overrides for channel-backed resource sources.
 *
 * Only "off or archived" states are stored: `setSourceLifecycleState` deletes
 * the row again once a source is both enabled and not archived, so the table
 * stays empty in the common case.
 */

function normalize(value: unknown): string { return String(value || "").trim().replace(/^@/, "").toLowerCase(); }
function readStates(): SourceLifecycleMap {
  const db = getSqliteDatabase();
  return sanitizeSourceLifecycleStates(Object.fromEntries(db.allRows<any>("SELECT channel,enabled,deleted FROM source_lifecycle_states ORDER BY channel").map((row) => [row.channel, { enabled: Boolean(row.enabled), deleted: Boolean(row.deleted) }])));
}
export function getSourceLifecycleStates(): SourceLifecycleMap { return structuredClone(readStates()); }
export function getSourceLifecycleState(sourceId: string): SourceLifecycleEntry | undefined { return getSourceLifecycleStates()[normalize(sourceId)]; }
export function setSourceLifecycleState(sourceId: string, patch: { enabled?: boolean; deleted?: boolean }): SourceLifecycleEntry {
  const name = normalize(sourceId);
  if (!CHANNEL_NAME_PATTERN.test(name)) throw new Error(`invalid channel username: ${String(sourceId).slice(0, 64)}`);
  const current = getSourceLifecycleState(name) || { enabled: true, deleted: false };
  const next = { enabled: patch.enabled ?? current.enabled, deleted: patch.deleted ?? current.deleted };
  const db = getSqliteDatabase();
  db.run("INSERT INTO source_lifecycle_states(channel,enabled,deleted,updated_at) VALUES(?,?,?,?) ON CONFLICT(channel) DO UPDATE SET enabled=excluded.enabled,deleted=excluded.deleted,updated_at=excluded.updated_at", name, next.enabled ? 1 : 0, next.deleted ? 1 : 0, Date.now());
  if (next.enabled && !next.deleted) db.run("DELETE FROM source_lifecycle_states WHERE channel=?", name);
  return next;
}
export function clearSourceLifecycleState(sourceId: string): void { getSqliteDatabase().run("DELETE FROM source_lifecycle_states WHERE channel=?", normalize(sourceId)); }
export function countEffectiveChannelSources(channels: string[]): number {
  const states = getSourceLifecycleStates();
  return normalizeChannelNames(channels).filter((name) => !states[name]?.deleted && states[name]?.enabled !== false).length;
}
export interface PurgedChannelSource { channel: string; removedSystemEntries: number; removedSearchEntries: number; removedHealthRecords: number; }

/** Permanently remove an archived channel source and every row that referenced it. */
export function purgeChannelSource(sourceId: string): PurgedChannelSource {
  const name = normalize(sourceId);
  if (!CHANNEL_NAME_PATTERN.test(name)) throw new Error(`invalid channel username: ${String(sourceId).slice(0, 64)}`);
  const db = getSqliteDatabase();
  const archived = db.getRow<{ deleted: number }>("SELECT deleted FROM source_lifecycle_states WHERE channel=?", name);
  if (!archived?.deleted) throw new Error("Channel source must be archived before permanent deletion");
  const result = db.transaction(() => {
    const removedSystemEntries = db.run("DELETE FROM system_channels WHERE name=?", name).changes;
    const removedSearchEntries = db.run("DELETE FROM search_setting_channels WHERE channel=?", name).changes;
    // Health is stored by the unified SourceHealthChecker for every resource source.
    const removedHealthRecords = db.run("DELETE FROM source_health WHERE source_id=?", name).changes;
    db.run("DELETE FROM resource_sources WHERE id=?", name);
    db.run("DELETE FROM deleted_sources WHERE id=?", name);
    db.run("DELETE FROM source_lifecycle_states WHERE channel=?", name);
    return { removedSystemEntries, removedSearchEntries, removedHealthRecords };
  });
  return { channel: name, ...result };
}
