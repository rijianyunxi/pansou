/**
 * 热搜索存储接口
 * 定义 SQLite 热搜持久化的业务操作
 */
export interface IHotSearchStore {
  /**
   * 记录搜索词（增加分数）
   */
  recordSearch(term: string, now: number): Promise<void>;

  /**
   * 获取热搜列表
   */
  getHotSearches(limit: number): Promise<HotSearchItem[]>;

  /**
   * 获取热搜统计信息
   */
  getStats(): Promise<HotSearchStats>;


}

export interface HotSearchItem {
  term: string;
  normalizedTerm: string;
  score: number;
  lastSearched: number;
  createdAt: number;
  status: HotSearchStatus;
  source: HotSearchSource;
  pinned: boolean;
  manualWeight: number;
  updatedAt: number;
}

export type HotSearchStatus = "approved" | "pending" | "blocked" | "hidden";
export type HotSearchSource = "auto" | "manual";

export function normalizeHotSearchTerm(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, "")
    .trim();
}

/** Stable key used for de-duplicating hot-search terms, not content moderation. */
export function compactHotSearchTerm(value: string): string {
  return normalizeHotSearchTerm(value).replace(/[\s\p{P}\p{S}]+/gu, "");
}

export interface HotSearchStats {
  total: number;
  topTerms: HotSearchItem[];
}
