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

const MAX_BUCKETS = 10_000;

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

    if (this.buckets.size > MAX_BUCKETS) {
      this.prune(now);
      // A burst of fresh, unique keys must not bypass the size limit simply
      // because none of them has reached the one-hour cleanup age yet.
      while (this.buckets.size > MAX_BUCKETS) {
        const oldest = this.buckets.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.buckets.delete(oldest);
      }
    }
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

  /**
   * Read the current decision without consuming budget.
   *
   * Lets a caller gate an attempt on a budget that is only charged when the
   * attempt actually fails — see `credentialLoginLimiter`.
   */
  peek(
    key: string,
    options: RateLimitOptions,
    now = Date.now()
  ): RateLimitDecision {
    const current = this.buckets.get(key);
    const expired = !current || now - current.startedAt >= options.windowMs;
    const count = expired ? 0 : current.count;
    const retryAfterMs = expired
      ? 0
      : Math.max(0, options.windowMs - (now - current.startedAt));
    return {
      allowed: count < options.limit,
      remaining: Math.max(0, options.limit - count),
      retryAfterMs: count < options.limit ? 0 : retryAfterMs,
    };
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

/**
 * Throttles password sign-in. Only *failed* attempts are charged (via `peek` +
 * `check`), so an administrator who keeps signing in successfully never spends
 * budget. Kept separate from `adminRateLimiter` so that exhausting the console
 * budget can never make signing in impossible.
 */
export const credentialLoginLimiter = new MemoryRateLimiter();
