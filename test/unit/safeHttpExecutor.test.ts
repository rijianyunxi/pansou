import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeSafeHttp } from "../../server/core/http/safeHttpExecutor";
import {
  setHostResolver,
  type DnsLookupRecord,
} from "../../server/core/security/dnsGuard";
import { setPinnedHttpTransport } from "../../server/core/utils/fetch";

const baseRequest = {
  method: "GET" as const,
  url: "https://example.com/search",
  timeoutMs: 1_000,
  maxRequestBodyBytes: 64,
  maxResponseBytes: 128,
  maxRedirects: 2,
  followRedirects: false,
  expectedContentTypes: ["application/json"],
};

beforeEach(() => {
  // 套件默认显式禁用 DNS 校验（fail-open 退回原生 fetch + 逐跳静态校验），
  // 避免任何用例触发真实 DNS / 公网请求；需要校验的用例自行覆写。
  setHostResolver(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  setHostResolver(null);
  setPinnedHttpTransport(undefined);
});

describe("executeSafeHttp", () => {
  it("blocks sensitive headers before sending a request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      executeSafeHttp({
        ...baseRequest,
        headers: { "X-Forwarded-Host": "127.0.0.1" },
      })
    ).rejects.toThrow(/禁止设置请求头/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("revalidates each redirect and rejects private destinations", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/admin" },
      })
    );
    await expect(
      executeSafeHttp({ ...baseRequest, followRedirects: true })
    ).rejects.toThrow(/协议|内网/);
  });

  it("enforces streamed response limits", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("x".repeat(256), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    await expect(executeSafeHttp(baseRequest)).rejects.toThrow(/大小限制/);
  });

  it("propagates caller cancellation", async () => {
    const caller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      receivedSignal = init?.signal as AbortSignal;
      return await new Promise<Response>((_resolve, reject) => {
        // Mirror native fetch: an already-aborted signal rejects immediately.
        if (receivedSignal?.aborted) {
          reject(receivedSignal.reason);
          return;
        }
        receivedSignal?.addEventListener(
          "abort",
          () => reject(receivedSignal?.reason),
          { once: true }
        );
      });
    });
    const operation = executeSafeHttp({ ...baseRequest, signal: caller.signal });
    const reason = new Error("cancelled by search");
    caller.abort(reason);
    await expect(operation).rejects.toBe(reason);
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("fails with TimeoutError when the upstream exceeds the deadline", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
          once: true,
        });
      });
    });
    await expect(
      executeSafeHttp({ ...baseRequest, timeoutMs: 50 })
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("blocks hosts whose DNS resolves to a private address", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    setHostResolver(async () => [{ address: "10.1.2.3", family: 4 }]);
    await expect(
      executeSafeHttp({ ...baseRequest, url: "https://rebind.example/search" })
    ).rejects.toThrow(/DNS 解析到内网或保留地址/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pins the request to the DNS-validated address instead of calling fetch", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    setHostResolver(async () => [{ address: "93.184.216.34", family: 4 }]);
    const seen: Array<{ url: string; pinned: DnsLookupRecord[] }> = [];
    setPinnedHttpTransport({
      request: async (url, _init, pinned) => {
        seen.push({ url: url.toString(), pinned: [...pinned] });
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const result = await executeSafeHttp({
      ...baseRequest,
      url: "https://public.example/search",
    });
    expect(result.response.status).toBe(200);
    expect(seen).toEqual([
      {
        url: "https://public.example/search",
        pinned: [{ address: "93.184.216.34", family: 4 }],
      },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-resolves DNS and re-pins the transport on every redirect hop", async () => {
    const resolver = vi.fn(async (_hostname: string) => [
      { address: "93.184.216.34", family: 4 },
    ]);
    setHostResolver(resolver);
    const pinnedHosts: string[] = [];
    setPinnedHttpTransport({
      request: async (url) => {
        pinnedHosts.push(url.hostname);
        if (pinnedHosts.length === 1) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://public.example/next" },
          });
        }
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const result = await executeSafeHttp({
      ...baseRequest,
      url: "https://public.example/search",
      followRedirects: true,
    });
    expect(result.redirects).toBe(1);
    expect(result.url.toString()).toBe("https://public.example/next");
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(resolver.mock.calls.map(([hostname]) => hostname)).toEqual([
      "public.example",
      "public.example",
    ]);
    expect(pinnedHosts).toEqual(["public.example", "public.example"]);
  });

  it("falls back to native fetch when DNS verification is unavailable", async () => {
    setHostResolver(async () => {
      throw new Error("resolver down");
    });
    setPinnedHttpTransport({
      request: async () => {
        throw new Error("pinned transport must not be used");
      },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const result = await executeSafeHttp({
      ...baseRequest,
      url: "https://public.example/search",
    });
    expect(result.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
