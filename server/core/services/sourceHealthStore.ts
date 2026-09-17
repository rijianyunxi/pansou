import { getSqliteDatabase } from "../storage/sqlite";
import type { SourceHealthStatus } from "./sourceHealth";

/**
 * Persistent source-health snapshots.
 *
 * Each source is stored as one bounded JSON snapshot. SourceHealthChecker keeps
 * the runtime state in memory; this store only handles the restart boundary.
 */
export function loadSourceHealthSnapshot(): Record<string, SourceHealthStatus> {
  const rows = getSqliteDatabase().allRows<{ source_id: string; snapshot_json: string }>(
    "SELECT source_id,snapshot_json FROM source_health",
  );
  const snapshot: Record<string, SourceHealthStatus> = {};
  for (const row of rows) {
    if (!row?.source_id || typeof row.snapshot_json !== "string") continue;
    try {
      const parsed = JSON.parse(row.snapshot_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        snapshot[row.source_id] = { ...(parsed as SourceHealthStatus), name: row.source_id };
      }
    } catch {
      // A corrupt health row must not prevent the application from starting.
    }
  }
  return snapshot;
}

const UPSERT_SQL =
  "INSERT INTO source_health(source_id,snapshot_json,updated_at) VALUES(?,?,?) ON CONFLICT(source_id) DO UPDATE SET snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at";

/**
 * Pending health snapshots, keyed by source id.
 *
 * A search records health once per source it ran, so writing on every record
 * turned a single search into N full-snapshot JSON writes. Queueing collapses
 * them into one transaction flushed when the search ends; the worst case of a
 * crash before the flush is losing one search worth of counters, which the
 * next search rebuilds.
 */
const pending = new Map<string, SourceHealthStatus>();

/** Stage one already-sanitized public health status for the next flush. */
export function queueSourceHealthStatus(sourceId: string, status: SourceHealthStatus): void {
  if (!sourceId) return;
  pending.set(sourceId, status);
}

/** Write every staged snapshot in one transaction. Failures are non-fatal. */
export function flushSourceHealthStatuses(): number {
  if (!pending.size) return 0;
  const entries = [...pending.entries()];
  pending.clear();
  try {
    const db = getSqliteDatabase();
    const now = Date.now();
    db.transaction(() => {
      for (const [sourceId, status] of entries) {
        db.run(UPSERT_SQL, sourceId, JSON.stringify({ ...status, name: sourceId }), now);
      }
    });
    return entries.length;
  } catch {
    // Health persistence must never break the search path.
    return 0;
  }
}

/** Immediate single write. Search paths should prefer queue + flush. */
export function saveSourceHealthStatus(sourceId: string, status: SourceHealthStatus): boolean {
  if (!sourceId) return false;
  queueSourceHealthStatus(sourceId, status);
  return flushSourceHealthStatuses() > 0;
}

export function deleteSourceHealthStatus(sourceId: string): boolean {
  if (!sourceId) return false;
  pending.delete(sourceId);
  try {
    getSqliteDatabase().run("DELETE FROM source_health WHERE source_id=?", sourceId);
    return true;
  } catch {
    return false;
  }
}

export function clearSourceHealthStatuses(): boolean {
  pending.clear();
  try {
    getSqliteDatabase().run("DELETE FROM source_health");
    return true;
  } catch {
    return false;
  }
}

/** Remove snapshots for sources that are no longer present in the catalog. */
export function pruneSourceHealthStatuses(sourceIds: Iterable<string>): number {
  const ids = [...new Set([...sourceIds].map((id) => String(id).trim()).filter(Boolean))];
  // A staged snapshot for a removed source must not be resurrected by a later flush.
  const keep = new Set(ids);
  for (const sourceId of pending.keys()) {
    if (!keep.has(sourceId)) pending.delete(sourceId);
  }
  try {
    const db = getSqliteDatabase();
    if (!ids.length) return db.run("DELETE FROM source_health").changes;
    const placeholders = ids.map(() => "?").join(",");
    return db.run(
      `DELETE FROM source_health WHERE source_id NOT IN (${placeholders})`,
      ...ids,
    ).changes;
  } catch {
    return 0;
  }
}
