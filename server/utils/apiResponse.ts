import { createError, setHeader, type H3Event, type H3Error } from "h3";

/**
 * Response caching policy shared by every API handler.
 *
 * `setNoStore` is the baseline for any response that reflects live state.
 * `setPrivateNoStore` additionally marks the body as per-user so shared
 * proxies never reuse one visitor's payload for another.
 */
export function setNoStore(event: H3Event): void {
  setHeader(event, "Cache-Control", "no-store");
}

export function setPrivateNoStore(event: H3Event): void {
  setHeader(event, "Cache-Control", "private, no-store");
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return fallback;
}

/**
 * Normalize a caught error into an HTTP error.
 *
 * A service that already threw an HTTP error keeps its own status code so a
 * specific 404/409 is not flattened into a generic failure; everything else
 * (plain `Error`, thrown strings, unknown values) becomes `statusCode` with a
 * human-readable message.
 */
export function toHttpError(error: unknown, statusCode: number, fallback: string): H3Error {
  const existing = (error as { statusCode?: unknown } | null | undefined)?.statusCode;
  const resolved = typeof existing === "number" && existing >= 400 ? existing : statusCode;
  return createError({ statusCode: resolved, statusMessage: errorMessage(error, fallback) });
}
