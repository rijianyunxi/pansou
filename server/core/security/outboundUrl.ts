const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.google.com",
]);

function isBlockedIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some(
      (part) => !Number.isInteger(part) || part < 0 || part > 255
    )
  ) {
    return false;
  }
  const [a, b, c] = parts;
  if (a === undefined || b === undefined || c === undefined) return false;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isBlockedIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:") ||
    normalized.startsWith("::ffff:")
  );
}

/**
 * Single entry point for "is this resolved address a private/reserved IP?".
 * Accepts bare IPv4/IPv6 addresses (with optional brackets) as returned by
 * URL.hostname or DNS resolvers.
 */
export function isBlockedIp(address: string): boolean {
  const bare = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (bare.includes(":")) return isBlockedIpv6(bare);
  return isBlockedIpv4(bare);
}

export interface OutboundUrlOptions {
  allowedDomains?: readonly string[];
  baseUrl?: string;
  /** HTTP is denied by default and must be explicitly enabled per plugin. */
  allowHttp?: boolean;
}

export function validateOutboundUrl(
  raw: string,
  options: OutboundUrlOptions = {}
): URL {
  let url: URL;
  try {
    url = new URL(raw, options.baseUrl);
  } catch {
    throw new Error(`无效 URL: ${raw}`);
  }
  if (url.protocol !== "https:" && !(options.allowHttp && url.protocol === "http:")) {
    throw new Error(`禁止的 URL 协议: ${url.protocol}（默认仅允许 HTTPS）`);
  }
  if (url.username || url.password) throw new Error("URL 不允许包含凭据");
  if (
    url.port &&
    !(
      (url.protocol === "https:" && url.port === "443") ||
      (url.protocol === "http:" && url.port === "80")
    )
  ) {
    throw new Error(`禁止访问非标准端口: ${url.port}`);
  }

  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    !host ||
    BLOCKED_HOSTS.has(host) ||
    host.endsWith(".local") ||
    isBlockedIpv4(host) ||
    isBlockedIpv6(host)
  ) {
    throw new Error(`禁止访问内网或保留地址: ${host}`);
  }
  const allowed = options.allowedDomains?.map((domain) =>
    domain.toLowerCase().replace(/^\.+/, "").replace(/\.$/, "")
  );
  if (
    allowed?.length &&
    !allowed.some((domain) => host === domain || host.endsWith(`.${domain}`))
  ) {
    throw new Error(`域名不在允许白名单: ${host}`);
  }
  return url;
}

export function validateRedirectUrl(
  from: URL,
  to: string,
  options: Pick<OutboundUrlOptions, "allowedDomains" | "allowHttp"> = {}
): URL {
  return validateOutboundUrl(to, {
    baseUrl: from.toString(),
    allowedDomains: options.allowedDomains,
    allowHttp: options.allowHttp,
  });
}
