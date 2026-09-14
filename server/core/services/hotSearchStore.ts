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
  score: number;
  lastSearched: number;
  createdAt: number;
}

export interface HotSearchStats {
  total: number;
  topTerms: HotSearchItem[];
}
