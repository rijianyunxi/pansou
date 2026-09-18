type CacheRecord<T> = { value: T; expireAt: number; size: number };

export interface MemoryCacheOptions {
  maxMemoryBytes?: number; // 估算缓存载荷容量（字节）
  cleanupInterval?: number; // 清理间隔（毫秒）
  memoryThreshold?: number; // 内存阈值百分比（0-1），达到时触发清理
}

export class MemoryCache<T = unknown> {
  private store = new Map<string, CacheRecord<T>>();
  private accessOrder = new Map<string, number>(); // key -> 最后访问时间戳
  private options: Required<MemoryCacheOptions>;
  private lastCleanup = 0;
  private metrics = {
    hits: 0,
    misses: 0,
    evictions: 0,
  };
  private sequence = 0; // 单调递增序列，用于 LRU 排序

  constructor(options: MemoryCacheOptions = {}) {
    this.options = {
      maxMemoryBytes: options.maxMemoryBytes ?? 100 * 1024 * 1024, // 默认 100MB
      cleanupInterval: options.cleanupInterval ?? 5 * 60 * 1000,
      memoryThreshold: options.memoryThreshold ?? 0.8, // 80% 触发清理
    };
  }

  /**
   * 估算对象大小（字节）
   */
  private estimateSize(key: string, value: T): number {
    let valueSize = 64;
    try {
      if (value === null || value === undefined) valueSize = 8;
      else if (typeof value === 'string') valueSize = value.length * 2;
      else if (typeof value === 'number') valueSize = 8;
      else if (typeof value === 'boolean') valueSize = 4;
      if (typeof value === 'object') {
        // 简化的对象大小估算
        const str = JSON.stringify(value);
        valueSize = str ? str.length * 2 : 64;
      }
    } catch {
      valueSize = 64;
    }
    // Include the key and a small record overhead so many tiny entries cannot
    // bypass the single byte-based capacity policy.
    return key.length * 2 + valueSize + 32;
  }

  /**
   * 计算当前总内存占用
   */
  private calculateMemoryUsage(): number {
    let total = 0;
    for (const [, record] of this.store) {
      total += record.size;
    }
    return total;
  }

  /**
   * 淘汰最旧的条目（LRU）
   */
  private evictOldest(count: number = 1): void {
    const entries = Array.from(this.accessOrder.entries())
      .sort((a, b) => {
        // 先按时间戳排序，时间戳相同时按 key 排序保证稳定性
        if (a[1] !== b[1]) {
          return a[1] - b[1];
        }
        return a[0].localeCompare(b[0]);
      }); // 按时间戳排序，最旧在前

    const toEvict = entries.slice(0, count);
    for (const [key] of toEvict) {
      this.store.delete(key);
      this.accessOrder.delete(key);
      this.metrics.evictions++;
    }

    // 静默处理缓存淘汰
  }

  /**
   * 智能清理：优先清理过期条目，如果还不够则清理最旧的
   */
  private smartCleanup(force: boolean = false): void {
    const now = Date.now();

    // 检查是否需要清理（时间间隔）
    if (!force && now - this.lastCleanup < this.options.cleanupInterval) {
      return;
    }

    this.lastCleanup = now;
    const memoryUsage = this.calculateMemoryUsage();
    const memoryPercent = memoryUsage / this.options.maxMemoryBytes;

    // 只用缓存载荷字节数作为容量标准；条目数不参与回收决策。
    const needMemoryCleanup = memoryPercent > this.options.memoryThreshold;

    if (!needMemoryCleanup && !force) {
      return;
    }

    // 1. 先清理过期条目
    const expiredKeys: string[] = [];
    for (const [key, rec] of this.store) {
      if (rec.expireAt <= now) {
        expiredKeys.push(key);
      }
    }

    for (const key of expiredKeys) {
      this.store.delete(key);
      this.accessOrder.delete(key);
    }

    // 2. 如果仍然超过限制，按 LRU 淘汰
    let memoryOver = this.calculateMemoryUsage() - this.options.maxMemoryBytes;
    if (memoryOver > 0) {
      const entries = Array.from(this.accessOrder.entries())
        .sort((a, b) => a[1] - b[1]);

      for (const [key] of entries) {
        if (memoryOver <= 0) break;
        const rec = this.store.get(key);
        if (rec) {
          memoryOver -= rec.size;
          this.store.delete(key);
          this.accessOrder.delete(key);
          this.metrics.evictions++;
        }
      }
    }

    // 静默处理清理
  }

  get(key: string): { hit: boolean; value?: T } {
    this.smartCleanup();

    const rec = this.store.get(key);
    if (!rec) {
      this.metrics.misses++;
      return { hit: false };
    }

    if (rec.expireAt > Date.now()) {
      // 更新访问顺序（LRU）- 使用单调递增序列保证顺序
      this.sequence++;
      this.accessOrder.set(key, this.sequence);
      this.metrics.hits++;
      return { hit: true, value: rec.value };
    }

    // 已过期，删除
    this.store.delete(key);
    this.accessOrder.delete(key);
    this.metrics.misses++;
    return { hit: false };
  }

  set(key: string, value: T, ttlMs: number): void {
    this.smartCleanup();

    const size = this.estimateSize(key, value);
    // A single entry must not violate the cache's global memory contract. Keep
    // the previous value when an oversized replacement is rejected.
    if (size > this.options.maxMemoryBytes) return;

    // 如果 key 已存在，先删除（更新内存占用）
    if (this.store.has(key)) {
      const oldRec = this.store.get(key);
      if (oldRec) {
        // 内存占用变化
        this.store.delete(key);
        this.accessOrder.delete(key);
      }
    }

    const record: CacheRecord<T> = {
      value,
      expireAt: Date.now() + Math.max(0, ttlMs),
      size,
    };

    // 检查容量和内存限制
    const currentMemory = this.calculateMemoryUsage();
    const needMemoryEviction = (currentMemory + size) > this.options.maxMemoryBytes;

    if (needMemoryEviction) {
      // 智能淘汰：优先淘汰过期的
      const expiredKeys: string[] = [];
      for (const [k, rec] of this.store) {
        if (rec.expireAt <= Date.now()) {
          expiredKeys.push(k);
        }
      }

      // 删除所有过期条目
      for (const k of expiredKeys) {
        this.store.delete(k);
        this.accessOrder.delete(k);
        this.metrics.evictions++;
      }

      // 检查删除过期后是否还需要淘汰
      const currentMemoryAfter = this.calculateMemoryUsage();
      const stillNeedMemoryEviction = (currentMemoryAfter + size) > this.options.maxMemoryBytes;

      if (stillNeedMemoryEviction) {
        // 按 LRU 淘汰，直到新条目能够放入容量上限。
        let bytesToFree = (currentMemoryAfter + size) - this.options.maxMemoryBytes;
        const entries = Array.from(this.accessOrder.entries())
          .sort((a, b) => {
            if (a[1] !== b[1]) return a[1] - b[1];
            return a[0].localeCompare(b[0]);
          });

        for (const [k] of entries) {
          if (bytesToFree <= 0) break;
          const rec = this.store.get(k);
          if (rec) {
            bytesToFree -= rec.size;
            this.store.delete(k);
            this.accessOrder.delete(k);
            this.metrics.evictions++;
          }
        }
      }
    }

    this.store.set(key, record);
    this.sequence++;
    this.accessOrder.set(key, this.sequence);
  }

  delete(key: string): void {
    this.store.delete(key);
    this.accessOrder.delete(key);
  }

  clear(): void {
    this.store.clear();
    this.accessOrder.clear();
    this.metrics = { hits: 0, misses: 0, evictions: 0 };
    this.sequence = 0;
  }

  get size(): number {
    return this.store.size;
  }

  /** Update the byte limit and immediately evict older entries if needed. */
  setMaxMemoryBytes(maxMemoryBytes: number): void {
    if (!Number.isFinite(maxMemoryBytes) || maxMemoryBytes < 1) return;
    const normalized = Math.floor(maxMemoryBytes);
    if (this.options.maxMemoryBytes === normalized) return;
    this.options.maxMemoryBytes = normalized;
    this.smartCleanup(true);
  }

  get memoryUsage(): number {
    return this.calculateMemoryUsage();
  }

  /**
   * 手动触发清理（用于测试或紧急情况）
   */
  forceCleanup(): void {
    this.smartCleanup(true);
  }
}
