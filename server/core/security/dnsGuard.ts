import { isBlockedIp } from "./outboundUrl";

export interface DnsLookupRecord {
  address: string;
  family: number;
}

export type HostResolver = (
  hostname: string,
  signal?: AbortSignal,
) => Promise<DnsLookupRecord[]>;

const DOH_ENDPOINTS = [
  "https://cloudflare-dns.com/dns-query",
  "https://dns.google/resolve",
] as const;
const DOH_TIMEOUT_MS = 3_000;

let defaultResolver: HostResolver | null | undefined;

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

function isIpLiteral(hostname: string): boolean {
  const bare = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return /^[\d.]+$/.test(bare) || bare.includes(":");
}

function isSyntheticResolverAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  const parts = bare.split(".").map(Number);
  return (
    parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    parts[0] === 198 &&
    (parts[1] === 18 || parts[1] === 19)
  );
}

function blockedResolutionError(hostname: string, address: string): Error {
  return new Error(
    `DNS 解析到内网或保留地址: ${hostname} -> ${address}`
  );
}

function validateResolvedRecords(
  hostname: string,
  records: DnsLookupRecord[]
): DnsLookupRecord[] {
  for (const record of records) {
    if (isBlockedIp(record.address)) {
      throw blockedResolutionError(hostname, record.address);
    }
  }
  return records;
}

function dohAnswerRecords(payload: unknown): DnsLookupRecord[] {
  if (!payload || typeof payload !== "object") return [];
  const answer = (payload as { Answer?: unknown }).Answer;
  if (!Array.isArray(answer)) return [];
  return answer.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const type = (entry as { type?: unknown }).type;
    const data = (entry as { data?: unknown }).data;
    if (typeof data !== "string" || (type !== 1 && type !== 28)) return [];
    return [{ address: data, family: type === 28 ? 6 : 4 }];
  });
}

async function fetchDohRecords(
  endpoint: string,
  hostname: string,
  type: "A" | "AAAA",
  signal: AbortSignal,
): Promise<DnsLookupRecord[]> {
  const url = new URL(endpoint);
  url.searchParams.set("name", hostname);
  url.searchParams.set("type", type);
  const response = await fetch(url, {
    headers: { accept: "application/dns-json" },
    redirect: "error",
    signal,
  });
  if (!response.ok) return [];
  return dohAnswerRecords(await response.json());
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error("操作已取消");
}

async function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        const reason = signal.reason;
        reject(reason instanceof Error ? reason : new Error("操作已取消"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      promise.finally(() => signal.removeEventListener("abort", onAbort)).catch(() => undefined);
    }),
  ]);
}

async function resolveViaDoh(hostname: string, signal?: AbortSignal): Promise<DnsLookupRecord[] | null> {
  for (const endpoint of DOH_ENDPOINTS) {
    throwIfAborted(signal);
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), DOH_TIMEOUT_MS);
    try {
      // Prefer IPv4: the pinned transport currently connects the first
      // validated address and most upstreams publish an A record. Only query
      // AAAA when A is unavailable, avoiding an unnecessary extra round trip
      // on the common path.
      const ipv4 = await fetchDohRecords(endpoint, hostname, "A", controller.signal)
        .catch(() => []);
      if (ipv4.length) return ipv4;
      const ipv6 = await fetchDohRecords(endpoint, hostname, "AAAA", controller.signal)
        .catch(() => []);
      if (ipv6.length) return ipv6;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  return null;
}

/**
 * Resolve a hostname and return every address that passed the private/reserved
 * IP screening, so the caller can pin the actual socket to one of the returned
 * records (DNS rebinding defense: the connection must use exactly the address
 * that was validated, not a second resolution).
 *
 * Some managed runtimes deliberately map public DNS answers to the RFC 2544
 * benchmarking range 198.18.0.0/15 and route the request by hostname/SNI.
 * Those synthetic answers are not usable socket destinations, but rejecting
 * them makes every public upstream look like an SSRF attempt. In that one
 * narrowly identified case we re-resolve through fixed public DoH endpoints;
 * all other private/reserved answers are still rejected.
 *
 * Returns `null` when pinning is not possible and the caller must degrade to
 * its native transport (fail-open policy, unchanged behaviour):
 * - runtimes without `node:dns` (e.g. Cloudflare Workers) delegate DNS to the
 *   platform and have no way to pin sockets;
 * - the resolver itself fails — the real connection surfaces DNS failures on its own;
 * - the resolver returned no usable records.
 *
 * IP literals are validated directly and returned without a lookup.
 * Throws when any resolved address is private/reserved.
 */
export async function resolveSafeHostAddresses(
  hostname: string,
  signal?: AbortSignal,
): Promise<DnsLookupRecord[] | null> {
  if (isIpLiteral(hostname)) {
    const address = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (isBlockedIp(address)) {
      throw new Error(`禁止访问内网或保留地址: ${hostname}`);
    }
    return [{ address, family: address.includes(":") ? 6 : 4 }];
  }
  const active = await awaitWithAbort(loadDefaultResolver(), signal);
  if (!active) return null;

  let records: DnsLookupRecord[];
  try {
    records = await awaitWithAbort(active(hostname, signal), signal);
  } catch (error) {
    throwIfAborted(signal);
    return null;
  }
  if (records.length === 0) return null;

  const blocked = records.filter((record) => isBlockedIp(record.address));
  if (!blocked.length) return records;

  // Never turn a mixed answer into a public one: mixed private/public DNS
  // results are exactly the rebinding pattern this guard is meant to stop.
  if (
    blocked.length === records.length &&
    records.every((record) => isSyntheticResolverAddress(record.address))
  ) {
    const dohRecords = await resolveViaDoh(hostname, signal);
    if (dohRecords?.length) return validateResolvedRecords(hostname, dohRecords);
  }

  throw blockedResolutionError(hostname, blocked[0]!.address);
}
