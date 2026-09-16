import { createError, setHeader, type H3Event } from "h3";

export interface SearchGovernanceLimits {
  /** Concurrent in-flight searches allowed per session. */
  perClientInFlight: number;
  /** Fixed window length for the per-session admitted-search rate. */
  perClientWindowMs: number;
  /** Admitted searches per session within perClientWindowMs. */
  perClientWindowLimit: number;
  /** Instance-wide cap on concurrent in-flight searches. */
  globalInFlight: number;
  /** Instance-wide admitted-search limit within globalWindowMs. */
  globalWindowMs: number;
  globalWindowLimit: number;
  /** Best-effort Retry-After hint (seconds) when slots are unavailable. */
  inFlightRetryAfterSeconds: number;
}

/** Defaults mirror the initial policy values. Request handling reads policyService on every request. */
export const SEARCH_GOVERNANCE_LIMITS: SearchGovernanceLimits = {
  perClientInFlight: 2,
  perClientWindowMs: 60_000,
  perClientWindowLimit: 30,
  globalInFlight: 16,
  globalWindowMs: 60_000,
  globalWindowLimit: 120,
  inFlightRetryAfterSeconds: 2,
};

export type SearchRejectionReason =
  | "client_rate_limited"
  | "client_concurrency"
  | "global_rate_limited"
  | "global_capacity";

export interface SearchLease {
  /** Idempotent: exactly one release per admission, safe to call in finally. */
  release(): void;
}

export type SearchGovernanceDecision =
  | { allowed: true; lease: SearchLease; remainingInWindow: number }
  | {
    allowed: false;
    reason: SearchRejectionReason;
    statusCode: 429 | 503;
    retryAfterSeconds: number;
  };

interface InFlightEntry {
  count: number;
  lastSeenAt: number;
}

interface WindowEntry {
  startedAt: number;
  count: number;
}

function readWindow(entry: WindowEntry | undefined, windowMs: number, now: number): WindowEntry {
  if (!entry || now - entry.startedAt >= windowMs) return { startedAt: now, count: 0 };
  return entry;
}

/**
 * Single-process search governance. The key supplied by the caller is the
 * internal session id, never an IP address or user id.
 */
export class SearchGovernor {
  private readonly perSessionWindows = new Map<string, WindowEntry>();
  private globalWindow: WindowEntry | undefined;
  private readonly inFlight = new Map<string, InFlightEntry>();
  private inFlightCount = 0;

  tryBegin(
    key: string,
    limits: SearchGovernanceLimits,
    now = Date.now(),
  ): SearchGovernanceDecision {
    const held = this.inFlight.get(key)?.count ?? 0;
    if (held >= limits.perClientInFlight) {
      return {
        allowed: false,
        reason: "client_concurrency",
        statusCode: 429,
        retryAfterSeconds: limits.inFlightRetryAfterSeconds,
      };
    }
    if (this.inFlightCount >= limits.globalInFlight) {
      return {
        allowed: false,
        reason: "global_capacity",
        statusCode: 503,
        retryAfterSeconds: limits.inFlightRetryAfterSeconds,
      };
    }

    const sessionWindow = readWindow(this.perSessionWindows.get(key), limits.perClientWindowMs, now);
    const globalWindow = readWindow(this.globalWindow, limits.globalWindowMs, now);
    if (sessionWindow.count >= limits.perClientWindowLimit) {
      return {
        allowed: false,
        reason: "client_rate_limited",
        statusCode: 429,
        retryAfterSeconds: Math.max(1, Math.ceil((limits.perClientWindowMs - (now - sessionWindow.startedAt)) / 1000)),
      };
    }
    if (globalWindow.count >= limits.globalWindowLimit) {
      return {
        allowed: false,
        reason: "global_rate_limited",
        statusCode: 429,
        retryAfterSeconds: Math.max(1, Math.ceil((limits.globalWindowMs - (now - globalWindow.startedAt)) / 1000)),
      };
    }

    sessionWindow.count++;
    globalWindow.count++;
    this.perSessionWindows.set(key, sessionWindow);
    this.globalWindow = globalWindow;
    if (this.perSessionWindows.size > 10_000) this.prune(now, Math.max(limits.perClientWindowMs, limits.globalWindowMs));

    const entry = this.inFlight.get(key) ?? { count: 0, lastSeenAt: now };
    entry.count++;
    entry.lastSeenAt = now;
    this.inFlight.set(key, entry);
    this.inFlightCount++;

    let released = false;
    return {
      allowed: true,
      remainingInWindow: Math.min(
        limits.perClientWindowLimit - sessionWindow.count,
        limits.globalWindowLimit - globalWindow.count,
      ),
      lease: {
        release: () => {
          if (released) return;
          released = true;
          const current = this.inFlight.get(key);
          if (current) {
            current.count--;
            if (current.count <= 0) this.inFlight.delete(key);
          }
          this.inFlightCount = Math.max(0, this.inFlightCount - 1);
        },
      },
    };
  }

  totalInFlight(): number {
    return this.inFlightCount;
  }

  clientInFlight(key: string): number {
    return this.inFlight.get(key)?.count ?? 0;
  }

  reset(): void {
    this.perSessionWindows.clear();
    this.globalWindow = undefined;
    this.inFlight.clear();
    this.inFlightCount = 0;
  }

  private prune(now: number, windowMs: number): void {
    for (const [key, entry] of this.perSessionWindows) {
      if (now - entry.startedAt > windowMs) this.perSessionWindows.delete(key);
    }
  }
}

export const searchGovernor = new SearchGovernor();

export function searchSessionKey(sessionId: number): string {
  return `session:${sessionId}`;
}

/**
 * Admit one search using the internal session id. Callers should resolve the
 * user/session and policy before calling this function; it never consults IP.
 */
export function beginSearchLease(
  event: H3Event,
  sessionId: number,
  limits: SearchGovernanceLimits = SEARCH_GOVERNANCE_LIMITS,
): SearchLease {
  const decision = searchGovernor.tryBegin(searchSessionKey(sessionId), limits);
  if (!decision.allowed) {
    setHeader(event, "Retry-After", Math.max(1, decision.retryAfterSeconds));
    throw createError({
      statusCode: decision.statusCode,
      statusMessage:
        decision.reason === "global_capacity"
          ? "search capacity temporarily exhausted"
          : decision.reason === "global_rate_limited"
            ? "search capacity temporarily limited"
            : decision.reason === "client_rate_limited"
              ? "too many search requests"
              : "too many concurrent searches",
    });
  }
  setHeader(event, "X-RateLimit-Remaining", String(decision.remainingInWindow));
  return decision.lease;
}
