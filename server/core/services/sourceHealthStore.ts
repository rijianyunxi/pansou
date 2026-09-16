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

/** Persist one already-sanitized public health status. Failures are non-fatal. */
export function saveSourceHealthStatus(sourceId: string, status: SourceHealthStatus): boolean {
  if (!sourceId) return false;
  try {
    getSqliteDatabase().run(
      "INSERT INTO source_health(source_id,snapshot_json,updated_at) VALUES(?,?,?) ON CONFLICT(source_id) DO UPDATE SET snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at",
      sourceId,
      JSON.stringify({ ...status, name: sourceId }),
      Date.now(),
    );
    return true;
  } catch {
    // Health persistence must never break the search path.
    return false;
  }
}

export function deleteSourceHealthStatus(sourceId: string): boolean {
  if (!sourceId) return false;
  try {
    getSqliteDatabase().run("DELETE FROM source_health WHERE source_id=?", sourceId);
    return true;
  } catch {
    return false;
  }
}

export function clearSourceHealthStatuses(): boolean {
  try {
    getSqliteDatabase().run("DELETE FROM source_health");
    return true;
  } catch {
    return false;
  }
}
