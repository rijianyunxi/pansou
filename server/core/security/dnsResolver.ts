import { ipAddressFamily } from "./ipAddress";
import { createAbortScope, throwIfAborted } from "../utils/abort";

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

let defaultResolver: HostResolver | undefined;

export async function loadDefaultResolver(): Promise<HostResolver> {
  if (defaultResolver) return defaultResolver;
  try {
    const dns = await import("node:dns/promises");
    defaultResolver = (hostname) =>
      dns.lookup(hostname, { all: true, order: "verbatim" });
    return defaultResolver;
  } catch {
    // Without an independently validated resolver we must not let native fetch
    // perform an unverified DNS lookup. Hostnames fail closed; IP literals are
    // still validated directly by resolveSafeHostAddresses.
    throw new Error("当前运行时不支持安全 DNS 校验，已拒绝访问域名");
  }
}

function dohAnswerRecords(payload: unknown): DnsLookupRecord[] {
  if (!payload || typeof payload !== "object") return [];
  const answer = (payload as { Answer?: unknown }).Answer;
  if (!Array.isArray(answer)) return [];
  return answer.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const type = (entry as { type?: unknown }).type;
    const data = (entry as { data?: unknown }).data;
    if (typeof data !== "string" || (type !== 1 && type !== 28)) {
      return [];
    }
    if (ipAddressFamily(data) !== (type === 1 ? 4 : 6)) return [];
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


/** Fixed-provider fallback, used only for synthetic system DNS answers. */
export async function resolveViaDoh(
  hostname: string,
  signal?: AbortSignal,
): Promise<DnsLookupRecord[] | null> {
  for (const endpoint of DOH_ENDPOINTS) {
    throwIfAborted(signal);
    const scope = createAbortScope(signal, DOH_TIMEOUT_MS);
    try {
      // Inspect both families; a public A must not hide a private AAAA.
      const [ipv4, ipv6] = await Promise.all([
        fetchDohRecords(endpoint, hostname, "A", scope.signal).catch(() => []),
        fetchDohRecords(endpoint, hostname, "AAAA", scope.signal).catch(() => []),
      ]);
      throwIfAborted(signal);
      const records = [...ipv4, ...ipv6];
      if (records.length) return records;
    } finally {
      scope.dispose();
    }
  }
  return null;
}
