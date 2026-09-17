import {
  isBlockedIp,
  ipAddressFamily,
  isSyntheticResolverAddress,
  normalizeIpAddress,
} from "./ipAddress";
import {
  loadDefaultResolver,
  resolveViaDoh,
  type DnsLookupRecord,
  type HostResolver,
} from "./dnsResolver";
import { awaitWithAbort, throwIfAborted } from "../utils/abort";

export type { DnsLookupRecord, HostResolver } from "./dnsResolver";

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
    const family = ipAddressFamily(record.address);
    if (!family || record.family !== family || isBlockedIp(record.address)) {
      throw blockedResolutionError(hostname, record.address);
    }
  }
  return records.map(record => ({ ...record, address: normalizeIpAddress(record.address) }));
}


export interface DnsGuardDependencies {
  loadResolver(): Promise<HostResolver>;
  resolveDoh(hostname: string, signal?: AbortSignal): Promise<DnsLookupRecord[] | null>;
}

/**
 * Validate every resolved address before the transport pins its socket.
 * Only entirely synthetic 198.18.0.0/15 answers may use the fixed DoH fallback;
 * missing resolvers, empty answers and private/mixed answers fail closed.
 */
export function createDnsGuard(
  dependencies: DnsGuardDependencies,
): HostResolver {
  return async (hostname, signal) => {
    throwIfAborted(signal);
    const family = ipAddressFamily(hostname);
    if (family) {
      const address = normalizeIpAddress(hostname);
      if (isBlockedIp(address)) {
        throw new Error("禁止访问内网或保留地址: " + hostname);
      }
      return [{ address, family }];
    }
    const resolver = await awaitWithAbort(dependencies.loadResolver(), signal);
    throwIfAborted(signal);
    let records: DnsLookupRecord[];
    try {
      records = await awaitWithAbort(resolver(hostname, signal), signal);
    } catch (error) {
      throwIfAborted(signal);
      const detail = error instanceof Error && error.message ? ": " + error.message : "";
      throw new Error("DNS 解析失败，已拒绝访问 " + hostname + detail);
    }
    throwIfAborted(signal);
    if (records.length === 0) {
      throw new Error("DNS 未返回可用地址，已拒绝访问 " + hostname);
    }

    // Never hide a private or mixed answer behind a more permissive lookup.
    if (records.every((record) => isSyntheticResolverAddress(record.address))) {
      const dohRecords = await awaitWithAbort(dependencies.resolveDoh(hostname, signal), signal);
      throwIfAborted(signal);
      if (dohRecords?.length) return validateResolvedRecords(hostname, dohRecords);
    }
    return validateResolvedRecords(hostname, records);
  };
}

export const resolveSafeHostAddresses = createDnsGuard({
  loadResolver: loadDefaultResolver,
  resolveDoh: resolveViaDoh,
});
