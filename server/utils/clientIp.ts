import { getHeader, getRequestIP, type H3Event } from "h3";

function trustProxyHeaders(event: H3Event): boolean {
  // Forwarded client-IP headers are spoofable when the app is directly
  // reachable. They are opt-in and should only be enabled when the listener
  // accepts traffic exclusively from a trusted reverse proxy.
  try {
    const config = useRuntimeConfig(event) as { trustProxy?: unknown };
    if (config.trustProxy === true) return true;
  } catch {
    // Unit tests and non-Nitro callers may not have runtime config.
  }
  return false;
}

function normalizeIp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const ip = value.trim().replace(/^::ffff:/i, "");
  return ip && ip !== "unknown" ? ip : undefined;
}

/** Minimal view of the Node request needed to read the peer socket address. */
type NodePeer = { remoteAddress?: string };
type NodeRequest = { socket?: NodePeer; connection?: NodePeer };

/** Resolve the client address for audit records, with a socket fallback for local/dev requests. */
export function getClientIp(event: H3Event): string {
  const trustProxy = trustProxyHeaders(event);
  if (trustProxy) {
    const detected = normalizeIp(getRequestIP(event, { xForwardedFor: true }));
    if (detected) return detected;

    const forwarded = getHeader(event, "cf-connecting-ip") || getHeader(event, "x-forwarded-for")?.split(",")[0];
    const forwardedIp = normalizeIp(forwarded);
    if (forwardedIp) return forwardedIp;
  }

  // Never inspect forwarded headers in the default mode: a direct client can
  // set them arbitrarily and otherwise bypass IP rate limits or corrupt audit logs.
  const request = event.node?.req as unknown as NodeRequest | undefined;
  const socket = request?.socket ?? request?.connection;
  return normalizeIp(socket?.remoteAddress) || normalizeIp(getRequestIP(event)) || "unknown";
}
