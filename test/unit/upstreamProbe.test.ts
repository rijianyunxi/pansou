import { afterEach, describe, expect, it, vi } from "vitest";
import { probeBuiltinUpstream } from "../../server/core/services/upstreamProbe";
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
afterEach(() => vi.unstubAllGlobals());
describe("safe upstream probing", () => {
  it("does not mistake HTTP 200 with business 414 for healthy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ code: 414, msg: "请求验证失败" })),
    );
    const result = await probeBuiltinUpstream("hunhepan", "三体");
    expect(result).toMatchObject({
      state: "error",
      httpStatus: 200,
      businessCode: "414",
      results: [],
    });
    expect(result.traces).toHaveLength(1);
  });
  it("returns real normalized results and uses no redirect following", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        json({
          code: 200,
          data: {
            list: [
              {
                disk_name: "test",
                link: "https://pan.quark.cn/s/test",
                disk_type: "QUARK",
              },
            ],
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await probeBuiltinUpstream("hunhepan", "test");
    expect(result.state).toBe("available");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.links[0]!.type).toBe("quark");
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      redirect: "manual",
      method: "POST",
    });
  });
  it("keeps empty valid result distinct from a failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ code: 200, data: { list: [] } })),
    );
    expect((await probeBuiltinUpstream("hunhepan", "empty")).state).toBe(
      "available",
    );
  });
  it("rejects redirects without requesting their destination", async () => {
    const mock = vi
      .fn()
      .mockResolvedValue(
        new Response("", {
          status: 302,
          headers: { location: "http://127.0.0.1" },
        }),
      );
    vi.stubGlobal("fetch", mock);
    expect((await probeBuiltinUpstream("nyaa", "test")).state).toBe("error");
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it("reports network failures without inventing an HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValue(
          new Error("fetch failed", {
            cause: { code: "CERT_HAS_EXPIRED", message: "certificate expired" },
          }),
        ),
    );
    const result = await probeBuiltinUpstream("hunhepan", "test");
    expect(result.httpStatus).toBeNull();
    expect(result.message).toContain("CERT_HAS_EXPIRED");
    expect(result.traces[0]!.error).toContain("certificate expired");
  });
  it("marks HTML transport-only adapters as unconfirmed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>Loading…</html>")),
    );
    expect((await probeBuiltinUpstream("duoduo", "test")).state).toBe(
      "warning",
    );
  });
  it("parses Nyaa results rather than accepting any HTML page", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            '<table class="torrent-list"><tbody><tr><td></td><td><a href="/view/123">Test</a></td><td><a href="magnet:?xt=urn:btih:abc">magnet</a></td></tr></tbody></table>',
          ),
        ),
    );
    expect((await probeBuiltinUpstream("nyaa", "test")).results[0]!.title).toBe(
      "Test",
    );
  });
  it("fetches PanSearch data only at the fixed host", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"buildId":"safe_build"}'))
      .mockResolvedValueOnce(
        json({
          pageProps: {
            data: {
              data: [
                {
                  content: '<a href="https://pan.quark.cn/s/test">resource</a>',
                },
              ],
            },
          },
        }),
      );
    vi.stubGlobal("fetch", mock);
    const result = await probeBuiltinUpstream("pansearch", "a&b");
    expect(result.state).toBe("available");
    expect(result.traces).toHaveLength(2);
    expect(mock.mock.calls[1]![0]).toBe(
      "https://www.pansearch.me/_next/data/safe_build/search.json?keyword=a%26b&offset=0",
    );
  });
  it("limits response bytes and rejects malformed JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("x".repeat(1024 * 1024 + 1)))
        .mockResolvedValueOnce(new Response("<html>Error</html>")),
    );
    expect((await probeBuiltinUpstream("hunhepan", "test")).message).toContain(
      "1 MiB",
    );
    expect((await probeBuiltinUpstream("hunhepan", "test")).message).toContain(
      "不是预期的 JSON",
    );
  });
  it("rejects unknown targets before network access", async () => {
    const mock = vi.fn();
    vi.stubGlobal("fetch", mock);
    await expect(probeBuiltinUpstream("custom-123", "test")).rejects.toThrow(
      "Unknown upstream",
    );
    expect(mock).not.toHaveBeenCalled();
  });
});
