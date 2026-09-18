import { MemoryCache } from "./memoryCache";
import type { SearchResult } from "../types/models";

/**
 * 缓存命名空间
 */
export enum CacheNamespace {
  HOT_SEARCH = "hot_search",
  SEARCH = "search",
}

/**
 * 统一缓存配置
 */
export interface UnifiedCacheConfig {
  enabled: boolean;
  ttlMinutes: number;
  maxMemoryBytes?: number;
}

/**
 * 统一缓存管理器
 * 提供命名空间支持和统一的缓存操作
 */
export class UnifiedCache<T = SearchResult[]> {
  private caches: Map<string, MemoryCache<T>> = new Map();
  private config: UnifiedCacheConfig;
  private namespacePrefix: string;

  constructor(config: UnifiedCacheConfig, namespacePrefix: string = "") {
    this.config = config;
    this.namespacePrefix = namespacePrefix;
  }

  /**
   * 生成完整的缓存键
   */
  private buildKey(namespace: CacheNamespace, key: string): string {
    const prefix = this.namespacePrefix ? `${this.namespacePrefix}:` : "";
    return `${prefix}${namespace}:${key}`;
  }

  /**
   * 获取或创建命名空间对应的缓存实例
   */
  private getCache(namespace: CacheNamespace): MemoryCache<T> {
    const cacheKey = this.namespacePrefix
      ? `${this.namespacePrefix}:${namespace}`
      : namespace;

    if (!this.caches.has(cacheKey)) {
      const cache = new MemoryCache<T>({
        maxMemoryBytes: this.config.maxMemoryBytes,
      });
      this.caches.set(cacheKey, cache);
    }

    return this.caches.get(cacheKey)!;
  }

  /**
   * 获取缓存
   */
  get(namespace: CacheNamespace, key: string): { hit: boolean; value?: T } {
    if (!this.config.enabled) {
      return { hit: false };
    }

    const cache = this.getCache(namespace);
    const fullKey = this.buildKey(namespace, key);
    return cache.get(fullKey);
  }

  /**
   * 设置缓存
   */
  set(namespace: CacheNamespace, key: string, value: T): void {
    if (!this.config.enabled) {
      return;
    }

    const cache = this.getCache(namespace);
    const fullKey = this.buildKey(namespace, key);
    const ttlMs = this.config.ttlMinutes * 60 * 1000;
    cache.set(fullKey, value, ttlMs);
  }

  setTtlMinutes(ttlMinutes: number): void {
    if (Number.isFinite(ttlMinutes) && ttlMinutes > 0) {
      if (this.config.ttlMinutes !== ttlMinutes) this.clearAll();
      this.config.ttlMinutes = ttlMinutes;
    }
  }

  setMaxMemoryBytes(maxMemoryBytes: number): void {
    if (!Number.isFinite(maxMemoryBytes) || maxMemoryBytes < 1) return;
    const normalized = Math.floor(maxMemoryBytes);
    this.config.maxMemoryBytes = normalized;
    for (const cache of this.caches.values()) cache.setMaxMemoryBytes(normalized);
  }

  /**
   * 删除缓存
   */
  delete(namespace: CacheNamespace, key: string): void {
    const cache = this.getCache(namespace);
    const fullKey = this.buildKey(namespace, key);
    cache.delete(fullKey);
  }

  /**
   * 清空所有缓存
   */
  clearAll(): void {
    this.caches.forEach((cache) => cache.clear());
  }

  /**
   * 强制清理所有命名空间的缓存
   */
  forceCleanup(): void {
    this.caches.forEach((cache) => cache.forceCleanup());
  }
}
