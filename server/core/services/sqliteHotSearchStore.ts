import type { IHotSearchStore, HotSearchItem, HotSearchStats } from "./hotSearchStore";
import { getSqliteDatabase } from "../storage/sqlite";

const MAX_ENTRIES = 30;
const NAMESPACE = "hot_searches";
const KEY = "items";

function forbidden(term: string): boolean {
  return [/政治|暴力|色情|赌博|毒品/i, /fuck|shit|bitch/i].some((pattern) => pattern.test(term));
}
function read(): Record<string, HotSearchItem> {
  const database = getSqliteDatabase();
  const current = database.get<Record<string, HotSearchItem>>(NAMESPACE, KEY, {});
  // Older development databases imported hot-searches.json under `state`.
  // Read it once as a fallback so the migration is lossless.
  if (Object.keys(current).length) return current;
  return database.get<Record<string, HotSearchItem>>(NAMESPACE, "state", {});
}
function ordered(map: Record<string, HotSearchItem>, limit = MAX_ENTRIES): HotSearchItem[] {
  return Object.values(map).sort((a, b) => b.score - a.score || b.lastSearched - a.lastSearched).slice(0, Math.min(MAX_ENTRIES, Math.max(0, limit)));
}
function write(map: Record<string, HotSearchItem>): void { getSqliteDatabase().set(NAMESPACE, KEY, map); }

export class SqliteHotSearchStore implements IHotSearchStore {
  async recordSearch(term: string, now: number): Promise<void> {
    const value = term.trim(); if (!value || forbidden(value)) return;
    const map = read(); const existing = map[value];
    map[value] = existing ? { ...existing, score: existing.score + 1, lastSearched: now } : { term: value, score: 1, lastSearched: now, createdAt: now };
    const entries = ordered(map); const trimmed: Record<string, HotSearchItem> = Object.fromEntries(entries.map((item) => [item.term, item])); write(trimmed);
  }
  async getHotSearches(limit: number): Promise<HotSearchItem[]> { return ordered(read(), limit); }
  async cleanupOldEntries(maxEntries: number): Promise<void> { const entries = ordered(read(), maxEntries); write(Object.fromEntries(entries.map((item) => [item.term, item]))); }
  async clearHotSearches(): Promise<{ success: boolean; message: string }> { write({}); return { success: true, message: "热搜记录已清除" }; }
  async deleteHotSearch(term: string): Promise<{ success: boolean; message: string }> { const map = read(); if (!(term in map)) return { success: false, message: "热搜词不存在" }; delete map[term]; write(map); return { success: true, message: `热搜词 "${term}" 已删除` }; }
  async getStats(): Promise<HotSearchStats> { const all = ordered(read()); return { total: all.length, topTerms: all.slice(0, 10) }; }
  getFileSize(): number { return 0; }
  close(): void {}
}
