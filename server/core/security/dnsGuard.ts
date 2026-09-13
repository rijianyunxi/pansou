import { isBlockedIp } from "./outboundUrl";

export interface DnsLookupRecord {
  address: string;
  family: number;
}

export type HostResolver = (
  hostname: string
) => Promise<DnsLookupRecord[]>;

let defaultResolver: HostResolver | null | undefined;
let overrideResolver: HostResolver | null | undefined;

async function loadDefaultResolver(): Promise<HostResolver | null> {
  if (defaultResolver !== undefined) return defaultResolver;
  try {
    const dns = await import("node:dns/promises");
    defaultResolver = (hostname) =>
      dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    // Runtimes without node:dns (e.g. Cloudflare Workers) delegate DNS to the
    // platform; hostname/IP-literal validation in validateOutboundUrl still applies.
    defaultResolver = null;
  }
  return defaultResolver;
}

/**
 * Test/admin hook: pin or disable the resolver used by
 * `assertSafeHostResolution` (null disables DNS verification).
 */
export function setHostResolver(resolver: HostResolver | null | undefined): void {
  overrideResolver = resolver;
}

function isIpLiteral(hostname: string): boolean {
  const bare = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return /^[\d.]+$/.test(bare) || bare.includes(":");
}

/**
 * Resolve a hostname and return every address that passed the private/reserved
 * IP screening, so the caller can pin the actual socket to one of the returned
 * records (DNS rebinding defense: the connection must use exactly the address
 * that was validated, not a second resolution).
 *
 * Returns `null` when pinning is not possible and the caller must degrade to
 * its native transport (fail-open policy, unchanged behaviour):
 * - runtimes without `node:dns` (e.g. Cloudflare Workers) delegate DNS to the
 *   platform and have no way to pin sockets;
 * - DNS verification is disabled (`setHostResolver(null)`) or the resolver
 *   itself fails — the real connection surfaces DNS failures on its own;
 * - the resolver returned no usable records.
 *
 * IP literals are validated directly and returned without a lookup.
 * Throws when any resolved address is private/reserved.
 */
export async function resolveSafeHostAddresses(
  hostname: string,
  resolver?: HostResolver | null
): Promise<DnsLookupRecord[] | null> {
  if (isIpLiteral(hostname)) {
    const address = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (isBlockedIp(address)) {
      throw new Error(`禁止访问内网或保留地址: ${hostname}`);
    }
    return [{ address, family: address.includes(":") ? 6 : 4 }];
  }
  const active =
    resolver !== undefined
      ? resolver
      : overrideResolver !== undefined
        ? overrideResolver
        : await loadDefaultResolver();
  if (!active) return null;

  let records: DnsLookupRecord[];
  try {
    records = await active(hostname);
  } catch {
    return null;
  }
  if (records.length === 0) return null;
  for (const record of records) {
    if (isBlockedIp(record.address)) {
      throw new Error(
        `DNS 解析到内网或保留地址: ${hostname} -> ${record.address}`
      );
    }
  }
  return records;
}

/**
 * Second line of defense against DNS rebinding: resolve the hostname and
 * reject when any resolved address is private/reserved. IP literals are
 * rejected directly without a lookup. Resolver unavailability is fail-open —
 * the subsequent real connection surfaces DNS failures on its own.
 * Callers that can control the socket should prefer `resolveSafeHostAddresses`
 * to also pin the connection to the validated address.
 */
export async function assertSafeHostResolution(
  hostname: string,
  resolver?: HostResolver | null
): Promise<void> {
  await resolveSafeHostAddresses(hostname, resolver);
}
