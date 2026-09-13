import { createError, getHeader, getRequestIP, setHeader, type H3Event } from "h3";
import { MemoryRateLimiter } from "./rateLimit";

export interface SearchGovernanceLimits {
  /** Concurrent in-flight searches allowed per client. */
  perClientInFlight: number;
  /** Fixed window length for the per-client admitted-search rate. */
  perClientWindowMs: number;
  /** Admitted searches per client within perClientWindowMs. */
  perClientWindowLimit: number;
  /** Instance-wide cap on concurrent in-flight searches. */
  globalInFlight: number;
  /** Best-effort Retry-After hint (seconds) when slots are unavailable. */
  inFlightRetryAfterSeconds: number;
}

/**
 * Instance-level search governance thresholds (single process, in-memory;
 * distributed deployments need a shared store, mirroring rateLimit.ts).
 *
 * - perClientInFlight 3 of a suggested 2-4: a search may run 30-120s, three
 *   slots let a normal browser page (search + refresh + prefetch) proceed
 *   while still bounding per-client amplification.
 * - perClientWindowLimit 30 / 30s: caps completed searches (each fanning out
 *   to every source) without throttling interactive use.
 * - globalInFlight 16: hard instance ceiling that holds even when client
 *   identities are spoofed, sized so TG/plugin shared concurrency slots are
 *   not starved by a single flood.
 */
export const SEARCH_GOVERNANCE_LIMITS: SearchGovernanceLimits = {
  perClientInFlight: 3,
  perClientWindowMs: 30_000,
  perClientWindowLimit: 30,
  globalInFlight: 16,
  inFlightRetryAfterSeconds: 2,
};

export type SearchRejectionReason =
  | "client_rate_limited"
  | "client_concurrency"
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

/**
 * Tracks per-client and instance-wide in-flight searches plus a per-client
 * admitted-request window. Slots are only handed out through tryBegin and are
 * always freed by the returned lease, so aborts and errors cannot leak counts.
 */
export class SearchGovernor {
  private readonly rateLimiter = new MemoryRateLimiter();
  private readonly inFlight = new Map<string, InFlightEntry>();
  private inFlightCount = 0;

  tryBegin(
    key: string,
    limits: SearchGovernanceLimits,
    now = Date.now()
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
    // Only admitted searches consume window tokens: requests rejected for
    // concurrency stay retryable without burning the rate budget.
    const rate = this.rateLimiter.check(
      key,
      { limit: limits.perClientWindowLimit, windowMs: limits.perClientWindowMs },
      now
    );
    if (!rate.allowed) {
      return {
        allowed: false,
        reason: "client_rate_limited",
        statusCode: 429,
        retryAfterSeconds: Math.max(1, Math.ceil(rate.retryAfterMs / 1000)),
      };
    }

    const entry = this.inFlight.get(key) ?? { count: 0, lastSeenAt: now };
    entry.count++;
    entry.lastSeenAt = now;
    this.inFlight.set(key, entry);
    this.inFlightCount++;

    let released = false;
    return {
      allowed: true,
      remainingInWindow: rate.remaining,
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
    this.inFlight.clear();
    this.inFlightCount = 0;
    this.rateLimiter.reset();
  }
}

export const searchGovernor = new SearchGovernor();

/**
 * Conservative client identity: the socket peer address, or cf-connecting-ip
 * which only the operator's edge may set. x-forwarded-for is deliberately
 * ignored — clients can forge it when the app is exposed directly, letting a
 * single client rotate identities past per-IP limits. Spoofed keys still hit
 * the global in-flight ceiling.
 */
export function searchClientKey(event: H3Event): string {
  return getHeader(event, "cf-connecting-ip") || getRequestIP(event) || "unknown";
}

/**
 * Admits one search request or throws an h3 error carrying Retry-After.
 * Ops endpoints (health, hot-searches, admin) never call this and stay
 * unlimited. Overrides exist for future config wiring; defaults are the
 * centralized constants above.
 */
export function beginSearchLease(
  event: H3Event,
  overrides?: Partial<SearchGovernanceLimits>
): SearchLease {
  const limits = { ...SEARCH_GOVERNANCE_LIMITS, ...overrides };
  const decision = searchGovernor.tryBegin(searchClientKey(event), limits);
  if (!decision.allowed) {
    setHeader(event, "Retry-After", Math.max(1, decision.retryAfterSeconds));
    throw createError({
      statusCode: decision.statusCode,
      statusMessage:
        decision.reason === "global_capacity"
          ? "search capacity temporarily exhausted"
          : decision.reason === "client_rate_limited"
            ? "too many search requests"
            : "too many concurrent searches",
    });
  }
  setHeader(event, "X-RateLimit-Remaining", String(decision.remainingInWindow));
  return decision.lease;
}
