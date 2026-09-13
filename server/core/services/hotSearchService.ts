import type { IHotSearchStore, HotSearchItem, HotSearchStats } from "./hotSearchStore";
import { SqliteHotSearchStore } from "./sqliteHotSearchStore";

/**
 * Hot-search persistence facade.
 *
 * SQLite is the only runtime store. Keeping the choice here (rather than in
 * every API handler) makes the storage contract explicit and prevents a
 * silent per-process memory fallback from losing admin-visible data.
 */
export class HotSearchService {
  private readonly store: IHotSearchStore;
  private readonly storeType = "sqlite" as const;

  constructor() {
    this.store = new SqliteHotSearchStore();
  }

  async recordSearch(term: string): Promise<void> {
    await this.store.recordSearch(term, Date.now());
  }

  async getHotSearches(limit = 30): Promise<HotSearchItem[]> {
    return this.store.getHotSearches(limit);
  }

  async clearHotSearches(): Promise<{ success: boolean; message: string }> {
    return this.store.clearHotSearches();
  }

  async deleteHotSearch(term: string): Promise<{ success: boolean; message: string }> {
    return this.store.deleteHotSearch(term);
  }

  async getStats(): Promise<{ total: number; topTerms: HotSearchItem[]; mode: string }> {
    const stats = await this.store.getStats();
    return { ...stats, mode: this.storeType };
  }

  /** SQLite size is intentionally not reported as a hot-search JSON size. */
  getDatabaseSize(): number { return 0; }
  getStoreType(): "sqlite" { return this.storeType; }
  close(): void { this.store.close(); }
}

const HOT_SEARCH_SERVICE_KEY = "__panhub_hot_search_service_v2__";

export function getOrCreateHotSearchService(): HotSearchService {
  const context = (globalThis as Record<string, unknown>)[HOT_SEARCH_SERVICE_KEY] as { service?: HotSearchService } | undefined;
  if (context?.service) return context.service;
  const service = new HotSearchService();
  (globalThis as Record<string, unknown>)[HOT_SEARCH_SERVICE_KEY] = { service };
  return service;
}

export function resetHotSearchService(): void {
  const context = (globalThis as Record<string, unknown>)[HOT_SEARCH_SERVICE_KEY] as { service?: HotSearchService } | undefined;
  context?.service?.close();
  delete (globalThis as Record<string, unknown>)[HOT_SEARCH_SERVICE_KEY];
}

export type { HotSearchItem, HotSearchStats };
