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
  const row = db.getRow<{ sources_configured: number }>("SELECT sources_configured FROM search_settings WHERE id=1");
  const sourceRows = db.allRows<{ source_id: string }>("SELECT source_id FROM search_setting_sources ORDER BY source_id");
  const configuredSources = sourceRows.map(row => row.source_id);
  return sanitize({ sources: row?.sources_configured ? configuredSources : null });
}
export function getSearchSettingsVersion(): string | null {
  const db = getSqliteDatabase();
  const row = db.getRow<{ updated_at: number }>("SELECT updated_at FROM search_settings WHERE id=1");
  const system = db.getRow<{ updated_at: number }>("SELECT updated_at FROM system_settings WHERE id=1");
  const updatedAt = Math.max(row?.updated_at ?? 0, system?.updated_at ?? 0);
  return `${updatedAt}:${getSearchSettings().sources?.join(",") || "*"}`;
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
    db.run("INSERT INTO search_settings(id,concurrency,sources_configured,updated_at) VALUES(1,NULL,?,?) ON CONFLICT(id) DO UPDATE SET concurrency=NULL,sources_configured=excluded.sources_configured,updated_at=excluded.updated_at", next.sources !== null ? 1 : 0, now);
    const sourceIds = [...new Set(next.sources || [])];
    if (sourceIds.length) db.run(`DELETE FROM search_setting_sources WHERE source_id NOT IN (${sourceIds.map(() => "?").join(",")})`, ...sourceIds);
    else db.run("DELETE FROM search_setting_sources");
    for (const id of sourceIds) db.run("INSERT INTO search_setting_sources(source_id) VALUES(?) ON CONFLICT(source_id) DO NOTHING", id);
  });
  return clone(next);
}
