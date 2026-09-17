import ipaddr from "ipaddr.js";

export function normalizeIpAddress(address: string): string {
  return address.toLowerCase().replace(/^\[|\]$/g, "");
}

/**
 * 判断地址是否为 IP literal。
 * 使用 ipaddr.js 而不是字符串/正则判断，覆盖压缩 IPv6、IPv4-mapped IPv6
 * 以及 WHATWG URL 已经规范化过的 IPv4 表示。
 */
export function isIpLiteral(hostname: string): boolean {
  return ipAddressFamily(hostname) !== undefined;
}

/** Preserve IPv6 family for mapped addresses; only range checks unwrap them. */
export function ipAddressFamily(address: string): 4 | 6 | undefined {
  const bare = normalizeIpAddress(address);
  if (!ipaddr.isValid(bare)) return undefined;
  return ipaddr.parse(bare).kind() === "ipv4" ? 4 : 6;
}

/**
 * Single entry point for "is this resolved address a private/reserved IP?".
 *
 * ipaddr.js 的 range() 会统一处理 IPv4/IPv6 的特殊网段，并且 process()
 * 会把 IPv4-mapped IPv6（例如 ::ffff:192.168.1.1）转换为 IPv4，避免
 * 只按字符串前缀判断导致漏检或把所有公网 mapped 地址都误杀。
 *
 * 对出站 SSRF 防护采用保守策略：只有标准 unicast 地址放行，其他特殊范围
 * （包括 loopback、private、link-local、CGNAT、保留、NAT64、6to4 等）全部拒绝。
 */
export function isBlockedIp(address: string): boolean {
  const bare = normalizeIpAddress(address);
  if (!ipaddr.isValid(bare)) return false;

  try {
    return ipaddr.process(bare).range() !== "unicast";
  } catch {
    return false;
  }
}

export function isSyntheticResolverAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  const parts = bare.split(".").map(Number);
  return (
    parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    parts[0] === 198 &&
    (parts[1] === 18 || parts[1] === 19)
  );
}

