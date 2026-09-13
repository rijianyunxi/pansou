import type { IHotSearchStore, HotSearchItem, HotSearchStats } from "./hotSearchStore";
import { getSqliteDatabase } from "../storage/sqlite";

const MAX_ENTRIES = 30;
function forbidden(term: string): boolean { return [/政治|暴力|色情|赌博|毒品/i, /fuck|shit|bitch/i].some(pattern => pattern.test(term)); }
function read(): HotSearchItem[] {
  return getSqliteDatabase().allRows<any>("SELECT term,score,last_searched AS lastSearched,created_at AS createdAt FROM hot_searches ORDER BY score DESC,last_searched DESC LIMIT ?", MAX_ENTRIES)
    .map(item => ({ term: item.term, score: item.score, lastSearched: item.lastSearched, createdAt: item.createdAt }));
}
export class SqliteHotSearchStore implements IHotSearchStore {
  async recordSearch(term: string, now: number): Promise<void> {
    const value = term.trim(); if (!value || forbidden(value)) return;
    const db = getSqliteDatabase();
    db.run("INSERT INTO hot_searches(term,score,last_searched,created_at) VALUES(?,1,?,?) ON CONFLICT(term) DO UPDATE SET score=score+1,last_searched=excluded.last_searched", value, now, now);
    db.run("DELETE FROM hot_searches WHERE term NOT IN (SELECT term FROM hot_searches ORDER BY score DESC,last_searched DESC LIMIT ?)", MAX_ENTRIES);
  }
  async getHotSearches(limit: number): Promise<HotSearchItem[]> { return read().slice(0, Math.min(MAX_ENTRIES, Math.max(0, limit))); }
  async cleanupOldEntries(maxEntries: number): Promise<void> { getSqliteDatabase().run("DELETE FROM hot_searches WHERE term NOT IN (SELECT term FROM hot_searches ORDER BY score DESC,last_searched DESC LIMIT ?)", Math.min(MAX_ENTRIES, Math.max(0, maxEntries))); }
  async clearHotSearches(): Promise<{ success: boolean; message: string }> { getSqliteDatabase().run("DELETE FROM hot_searches"); return { success: true, message: "热搜记录已清除" }; }
  async deleteHotSearch(term: string): Promise<{ success: boolean; message: string }> { const result = getSqliteDatabase().run("DELETE FROM hot_searches WHERE term=?", term); return result.changes ? { success: true, message: `热搜词 "${term}" 已删除` } : { success: false, message: "热搜词不存在" }; }
  async getStats(): Promise<HotSearchStats> { const all = read(); return { total: all.length, topTerms: all.slice(0, 10) }; }
  getFileSize(): number { return 0; }
  close(): void {}
}
