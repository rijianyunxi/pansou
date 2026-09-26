import { compactHotSearchTerm, normalizeHotSearchTerm, type IHotSearchStore, type HotSearchItem } from "./hotSearchStore";
import { getSqliteDatabase } from "../storage/sqlite";

const MAX_ENTRIES = 30;

type HotSearchRow = {
  term: string;
  normalized_term: string;
  score: number;
  last_searched: number;
  created_at: number;
  status: HotSearchItem["status"];
  source: HotSearchItem["source"];
  pinned: number;
  manual_weight: number;
  updated_at: number;
};

function normalizeLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.min(MAX_ENTRIES, Math.max(0, Math.floor(limit))) : MAX_ENTRIES;
}

export function rowToHotSearch(row: HotSearchRow): HotSearchItem {
  return {
    term: row.term,
    normalizedTerm: row.normalized_term,
    score: Number(row.score || 0),
    lastSearched: Number(row.last_searched || 0),
    createdAt: Number(row.created_at || 0),
    status: row.status,
    source: row.source,
    pinned: row.pinned === 1,
    manualWeight: Number(row.manual_weight || 0),
    updatedAt: Number(row.updated_at || 0),
  };
}

function read(limit = MAX_ENTRIES): HotSearchItem[] {
  const safeLimit = normalizeLimit(limit);
  const db = getSqliteDatabase();
  const rows = db.allRows<HotSearchRow>("SELECT term,normalized_term,score,last_searched,created_at,status,source,pinned,manual_weight,updated_at FROM hot_searches WHERE status='approved' ORDER BY pinned DESC,manual_weight DESC,score DESC,last_searched DESC LIMIT ?", safeLimit);
  return rows.map(rowToHotSearch);
}

export class SqliteHotSearchStore implements IHotSearchStore {
  async recordSearch(term: string, now: number): Promise<void> {
    const value = normalizeHotSearchTerm(term);
    const compact = compactHotSearchTerm(value);
    if (!compact || [...value].length > 100) return;
    const db = getSqliteDatabase();
    db.run(
      "INSERT INTO hot_searches(term,normalized_term,score,last_searched,created_at,status,source,pinned,manual_weight,updated_at) VALUES(?,?,1,?,?, 'approved','auto',0,0,?) ON CONFLICT(term) DO UPDATE SET score=score+1,last_searched=excluded.last_searched,updated_at=excluded.updated_at,status=CASE WHEN hot_searches.status IN ('blocked','hidden') THEN hot_searches.status ELSE 'approved' END",
      value, compact, now, now, now,
    );
    db.run("DELETE FROM hot_searches WHERE source='auto' AND pinned=0 AND status='approved' AND term NOT IN (SELECT term FROM hot_searches WHERE status='approved' ORDER BY pinned DESC,manual_weight DESC,score DESC,last_searched DESC LIMIT ?)", MAX_ENTRIES);
  }

  async getHotSearches(limit: number): Promise<HotSearchItem[]> { return read(limit); }
}
