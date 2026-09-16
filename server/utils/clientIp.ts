import { getHeader, getRequestIP, type H3Event } from "h3";

function normalizeIp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const ip = value.trim().replace(/^::ffff:/i, "");
  return ip && ip !== "unknown" ? ip : undefined;
}

/** Resolve the client address for audit records, with a socket fallback for local/dev requests. */
export function getClientIp(event: H3Event): string {
  const detected = normalizeIp(getRequestIP(event, { xForwardedFor: true }));
  if (detected) return detected;

  const forwarded = getHeader(event, "x-forwarded-for")?.split(",")[0];
  const forwardedIp = normalizeIp(forwarded);
  if (forwardedIp) return forwardedIp;

  const socket = (event.node?.req as any)?.socket || (event.node?.req as any)?.connection;
  return normalizeIp(socket?.remoteAddress) || "unknown";
}
