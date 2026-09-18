import { getUserPolicy } from "./policyService";

/** Single timeout policy for every source request and transform execution. */
export const MIN_UNIFIED_TIMEOUT_MS = 1_000;
export const MAX_UNIFIED_TIMEOUT_MS = 60_000;

export function normalizeUnifiedTimeoutMs(value: unknown, fallback = 5_000): number {
  const parsed = Number(value);
  const safeFallback = Math.min(MAX_UNIFIED_TIMEOUT_MS, Math.max(MIN_UNIFIED_TIMEOUT_MS, Math.round(Number(fallback) || 5_000)));
  return Number.isFinite(parsed)
    ? Math.min(MAX_UNIFIED_TIMEOUT_MS, Math.max(MIN_UNIFIED_TIMEOUT_MS, Math.round(parsed)))
    : safeFallback;
}

/** Read the one persisted timeout used by HTTP, channel fetches, probes, and transforms. */
export function getUnifiedRequestTimeoutMs(): number {
  return normalizeUnifiedTimeoutMs(getUserPolicy().requestTimeoutMs);
}
