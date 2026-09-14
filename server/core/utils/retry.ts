import { abortableDelay } from "./abort";

export interface FallbackRetryPolicy {
  /** Retries after the first attempt for each endpoint. */
  maxRetries?: number;
  /** Base delay before retrying the same endpoint. */
  delayMs?: number;
}

export interface FallbackAttempt {
  endpointIndex: number;
  attempt: number;
  url: string;
  ok: boolean;
  status: number | null;
  elapsedMs: number;
  error?: string;
}

export class FallbackExhaustedError extends Error {
  readonly attempts: readonly FallbackAttempt[];
  override readonly cause: unknown;

  constructor(message: string, attempts: readonly FallbackAttempt[], cause: unknown) {
    super(message);
    this.name = "FallbackExhaustedError";
    this.attempts = attempts;
    this.cause = cause;
  }
}

const MAX_RETRIES = 3;
const MAX_DELAY_MS = 5_000;

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(0, Math.floor(value!)));
}

function errorStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && Number.isFinite(status) ? status : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "请求失败");
}

/**
 * Execute a primary URL followed by fallback URLs. Each endpoint receives a
 * bounded number of retries before the next endpoint is attempted. The
 * operation owns the transport/security boundary; this helper only controls
 * ordering, cancellation and backoff.
 */
export async function runWithFallbackRetry<T>(
  urls: readonly string[],
  operation: (url: string) => Promise<T>,
  options: FallbackRetryPolicy & {
    signal?: AbortSignal;
    onAttemptStart?: (attempt: FallbackAttempt) => void;
    onAttempt?: (attempt: FallbackAttempt) => void;
  } = {},
): Promise<T> {
  const candidates = [...new Set(urls.map((url) => url.trim()).filter(Boolean))];
  if (!candidates.length) throw new Error("至少需要一个来源 URL");
  const maxRetries = boundedInteger(options.maxRetries, 0, MAX_RETRIES);
  const delayMs = boundedInteger(options.delayMs, 0, MAX_DELAY_MS);
  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (let endpointIndex = 0; endpointIndex < candidates.length; endpointIndex++) {
    const url = candidates[endpointIndex]!;
    for (let retryIndex = 0; retryIndex <= maxRetries; retryIndex++) {
      options.signal?.throwIfAborted();
      const attempt: FallbackAttempt = {
        endpointIndex,
        attempt: retryIndex + 1,
        url,
        ok: false,
        status: null,
        elapsedMs: 0,
      };
      options.onAttemptStart?.(attempt);
      const started = Date.now();
      try {
        const value = await operation(url);
        attempt.ok = true;
        attempt.status = errorStatus((value as { response?: { status?: unknown } } | null)?.response);
        attempt.elapsedMs = Date.now() - started;
        attempts.push({ ...attempt });
        options.onAttempt?.(attempt);
        return value;
      } catch (error) {
        attempt.elapsedMs = Date.now() - started;
        attempt.status = errorStatus(error) ?? errorStatus((error as { response?: unknown } | null)?.response);
        attempt.error = errorText(error).slice(0, 500);
        attempts.push({ ...attempt });
        options.onAttempt?.(attempt);
        lastError = error;
        if (options.signal?.aborted || (error instanceof Error && error.name === "ExecutionBudgetError")) throw error;
        if (retryIndex < maxRetries && delayMs > 0) {
          await abortableDelay(Math.min(MAX_DELAY_MS, delayMs * 2 ** retryIndex), options.signal);
        }
      }
    }
  }

  throw new FallbackExhaustedError(
    `来源主地址及 ${Math.max(0, candidates.length - 1)} 个备用地址均失败：${errorText(lastError)}`,
    attempts,
    lastError,
  );
}
