import { isBlockedIp, normalizeIpAddress } from "./ipAddress";

// Preserve the original public imports while keeping IP policy independent of URLs.
export { isBlockedIp, isIpLiteral } from "./ipAddress";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.google.com",
]);

export interface OutboundUrlOptions {
  allowedDomains?: readonly string[];
  baseUrl?: string;
  /** HTTP is denied by default and must be explicitly enabled per source. */
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

  const host = normalizeIpAddress(url.hostname).replace(/\.$/, "");
  if (
    !host ||
    BLOCKED_HOSTS.has(host) ||
    host.endsWith(".local") ||
    isBlockedIp(host)
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
