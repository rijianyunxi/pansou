export const FORBIDDEN_OUTBOUND_HEADERS = new Set([
  "cookie",
  "authorization",
  "proxy-authorization",
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "forwarded",
  "via",
]);

export function isForbiddenOutboundHeader(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    FORBIDDEN_OUTBOUND_HEADERS.has(normalized) ||
    normalized.startsWith("proxy-") ||
    normalized.startsWith("x-forwarded-")
  );
}

export function normalizeOutboundHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (isForbiddenOutboundHeader(name)) {
      throw new Error(`禁止设置请求头: ${name}`);
    }
    normalized[name] = String(value);
  }
  return normalized;
}

