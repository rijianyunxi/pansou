export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

interface RateLimitBucket {
  startedAt: number;
  count: number;
}

/** Small per-instance limiter; distributed deployments should replace its store. */
export class MemoryRateLimiter {
  private buckets = new Map<string, RateLimitBucket>();

  check(
    key: string,
    options: RateLimitOptions,
    now = Date.now()
  ): RateLimitDecision {
    const current = this.buckets.get(key);
    const bucket =
      !current || now - current.startedAt >= options.windowMs
        ? { startedAt: now, count: 0 }
        : current;
    bucket.count++;
    this.buckets.set(key, bucket);

    if (this.buckets.size > 10_000) this.prune(now);
    const retryAfterMs = Math.max(
      0,
      options.windowMs - (now - bucket.startedAt)
    );
    return {
      allowed: bucket.count <= options.limit,
      remaining: Math.max(0, options.limit - bucket.count),
      retryAfterMs: bucket.count <= options.limit ? 0 : retryAfterMs,
    };
  }

  reset(): void {
    this.buckets.clear();
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.startedAt > 60 * 60 * 1000) this.buckets.delete(key);
    }
  }
}

export const adminRateLimiter = new MemoryRateLimiter();

/** Shared search limiter for session and IP buckets. The policy controls the allowed count. */
export const searchRateLimiter = new MemoryRateLimiter();
