import { getSqliteDatabase } from "../storage/sqlite";

export interface SearchSettings { sources: string[] | null; }
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
  return { sources };
}

export function getSearchSettings(): SearchSettings {
  const db = getSqliteDatabase();
  // The source catalog is the canonical source of participation state. Keep
  // the legacy search_setting_sources table for compatibility, but never let
  // it make the settings dialog disagree with the source manager.
  const enabledSources = db.allRows<{ id: string }>(
    "SELECT id FROM resource_sources WHERE enabled=1 ORDER BY id",
  ).map((row) => row.id);
  return sanitize({ sources: enabledSources });
}
export function getSearchSettingsVersion(): string | null {
  const db = getSqliteDatabase();
  const row = db.getRow<{ updated_at: number }>("SELECT updated_at FROM search_settings WHERE id=1");
  const system = db.getRow<{ updated_at: number }>("SELECT updated_at FROM system_settings WHERE id=1");
  const updatedAt = Math.max(row?.updated_at ?? 0, system?.updated_at ?? 0);
  const sources = getSearchSettings().sources;
  return `${updatedAt}:${sources === null ? "*" : sources.join(",")}`;
}
/**
 * Keep the source catalog and the search selection in sync. The catalog's
 * enabled flag is the single source of truth; the legacy search selection is
 * mirrored only so older databases and callers remain compatible.
 */
export function setSearchSourceEnabled(id: string, enabled: boolean): SearchSettings {
  const normalizedId = String(id || "").trim();
  if (!normalizedId) return getSearchSettings();
  const current = getSearchSettings();
  const sources = new Set(current.sources || []);
  if (enabled) sources.add(normalizedId);
  else sources.delete(normalizedId);
  return saveSearchSettings({ sources: [...sources] });
}

export function saveSearchSettings(patch: unknown): SearchSettings {
  const next = sanitize({ ...getSearchSettings(), ...((patch && typeof patch === "object") ? patch as Record<string, unknown> : {}) });
  const db = getSqliteDatabase();
  const catalogIds = db.allRows<{ id: string }>("SELECT id FROM resource_sources ORDER BY id").map((row) => row.id);
  const catalogIdSet = new Set(catalogIds);
  const sourceIds = next.sources === null
    ? null
    : [...new Set(next.sources.filter((id) => catalogIdSet.has(id)))];
  const now = Date.now();
  db.transaction(() => {
    // Keep the catalog flag and the compatibility selection table aligned in
    // one transaction, so either UI cannot drift from the other.
    if (sourceIds !== null) {
      const selected = new Set(sourceIds);
      for (const id of catalogIds) {
        db.run("UPDATE resource_sources SET enabled=?,updated_at=? WHERE id=?", selected.has(id) ? 1 : 0, now, id);
      }
    }
    db.run("INSERT INTO search_settings(id,concurrency,sources_configured,updated_at) VALUES(1,NULL,?,?) ON CONFLICT(id) DO UPDATE SET concurrency=NULL,sources_configured=excluded.sources_configured,updated_at=excluded.updated_at", sourceIds !== null ? 1 : 0, now);
    if (sourceIds?.length) db.run(`DELETE FROM search_setting_sources WHERE source_id NOT IN (${sourceIds.map(() => "?").join(",")})`, ...sourceIds);
    else db.run("DELETE FROM search_setting_sources");
    for (const id of sourceIds || []) db.run("INSERT INTO search_setting_sources(source_id) VALUES(?) ON CONFLICT(source_id) DO NOTHING", id);
  });
  return clone(getSearchSettings());
}
