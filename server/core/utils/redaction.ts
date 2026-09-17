/**
 * Single place for masking credentials in anything that can leave the process:
 * request debug snapshots, admin probe traces and source logs.
 *
 * The key set is deliberately broad — over-redacting a debug field is harmless,
 * leaking a token is not. `key` is matched only as a standalone word so that
 * fields such as `keywords` are not masked by accident.
 */
const SENSITIVE_KEY_PATTERN =
  /(?:authorization|cookie|token|api[-_]?key|secret|password|passwd|credential|signature)/i;
const SENSITIVE_KEY_WORD_PATTERN = /(?:^|[-_])key(?:$|[-_])/i;

export const REDACTED = "[REDACTED]";

/** Whether a field or query-parameter name looks like it carries a credential. */
export function isSensitiveKey(name: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(name) || SENSITIVE_KEY_WORD_PATTERN.test(name);
}

/** Recursively masks object fields whose name looks like a credential. */
export function redactSensitiveValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      isSensitiveKey(key) ? REDACTED : redactSensitiveValue(child),
    ]),
  );
}

export function redactSensitiveHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      isSensitiveKey(key) ? REDACTED : value,
    ]),
  );
}

/** Keeps a URL readable while masking credential-shaped query parameters. */
export function redactSensitiveUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveKey(key)) url.searchParams.set(key, REDACTED);
    }
    return url.toString();
  } catch {
    return raw.slice(0, 500);
  }
}
