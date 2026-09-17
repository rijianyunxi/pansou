import type { IHotSearchStore, HotSearchItem, HotSearchStats } from "./hotSearchStore";
import { getSqliteDatabase } from "../storage/sqlite";

const MAX_ENTRIES = 30;
function forbidden(term: string): boolean { return [/政治|暴力|色情|赌博|毒品/i, /fuck|shit|bitch/i].some(pattern => pattern.test(term)); }
function normalizeLimit(limit: number): number {
  return Number.isFinite(limit)
    ? Math.min(MAX_ENTRIES, Math.max(0, Math.floor(limit)))
    : MAX_ENTRIES;
}
function read(limit = MAX_ENTRIES): HotSearchItem[] {
  const safeLimit = normalizeLimit(limit);
  return getSqliteDatabase().allRows<any>("SELECT term,score,last_searched AS lastSearched,created_at AS createdAt FROM hot_searches ORDER BY score DESC,last_searched DESC LIMIT ?", safeLimit)
    .map(item => ({ term: item.term, score: item.score, lastSearched: item.lastSearched, createdAt: item.createdAt }));
}
export class SqliteHotSearchStore implements IHotSearchStore {
  async recordSearch(term: string, now: number): Promise<void> {
    const value = term.trim(); if (!value || forbidden(value)) return;
    const db = getSqliteDatabase();
    db.run("INSERT INTO hot_searches(term,score,last_searched,created_at) VALUES(?,1,?,?) ON CONFLICT(term) DO UPDATE SET score=score+1,last_searched=excluded.last_searched", value, now, now);
    db.run("DELETE FROM hot_searches WHERE term NOT IN (SELECT term FROM hot_searches ORDER BY score DESC,last_searched DESC LIMIT ?)", MAX_ENTRIES);
  }
  async getHotSearches(limit: number): Promise<HotSearchItem[]> { return read(limit); }
  async getStats(): Promise<HotSearchStats> { const all = read(); return { total: all.length, topTerms: all.slice(0, 10) }; }
}
