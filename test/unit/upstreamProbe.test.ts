import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

describe("safe upstream probing", () => {
  let dir = "";
  let dbPath = "";
  let catalog: typeof import("../../server/core/services/upstreamCatalog");
  let probe: typeof import("../../server/core/services/upstreamProbe");
  let storage: typeof import("../../server/core/storage/sqlite");
  let dnsGuard: typeof import("../../server/core/security/dnsGuard");

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "panhub-upstream-probe-"));
    dbPath = join(dir, "panhub.sqlite");
    process.env.PANHUB_SQLITE_DB = dbPath;
    vi.resetModules();
    catalog = await import("../../server/core/services/upstreamCatalog");
    probe = await import("../../server/core/services/upstreamProbe");
    storage = await import("../../server/core/storage/sqlite");
    dnsGuard = await import("../../server/core/security/dnsGuard");
    dnsGuard.setHostResolver(null);
    await catalog.saveConfiguredUpstream({
      id: "custom-probe",
      name: "Custom probe",
      description: "",
      url: "https://example.com/api/search",
      method: "POST",
      format: "json",
      plugin: "custom-probe",
      adapter: "json-mapping",
      mapping: { items: "items", title: "title", url: "url", type: "type", password: "password" },
      request: {
        query: { page: "1", q: "{{keyword}}" },
        headers: { "x-debug-keyword": "{{keyword}}", "x-api-key": "test-secret" },
        bodyType: "json",
        body: { q: "{{keyword}}" },
      },
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    dnsGuard.setHostResolver(undefined);
    storage.resetSqliteDatabase(dbPath);
    delete process.env.PANHUB_SQLITE_DB;
    await rm(dir, { recursive: true, force: true });
  });

  it("returns normalized results from the configured request and mapping", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ items: [{ title: "test", url: "https://pan.quark.cn/s/test", type: "quark" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await probe.probeConfiguredUpstream("custom-probe", "test");
    expect(result.state).toBe("available");
    expect(result.results[0]).toMatchObject({ title: "test", links: [{ type: "quark" }] });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST", redirect: "manual" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ q: "test" });
    expect(result.traces[0]?.request).toEqual({
      url: "https://example.com/api/search?page=1&q=test",
      query: { page: "1", q: "test" },
      headers: {
        accept: "application/json",
        "x-debug-keyword": "test",
        "x-api-key": "[REDACTED]",
        "content-type": "application/json",
      },
      body: { q: "test" },
    });
  });

  it("probes an unsaved definition without writing it to the catalog", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ items: [] })));
    const draft = catalog.prepareUnifiedUpstreamForProbe({
      id: "draft-source",
      name: "Draft source",
      description: "",
      url: "https://example.com/draft",
      method: "GET",
      format: "json",
      plugin: "draft-source",
      adapter: "json-mapping",
      mapping: { items: "items", title: "title", url: "url", type: "type", password: "password" },
      request: { query: { keyword: "{{keyword}}" } },
    });
    const result = await probe.probeUpstreamDefinition(draft, "三体");
    expect(result.state).toBe("available");
    expect(result.traces[0]?.request?.query).toEqual({ keyword: "三体" });
    expect(catalog.getConfiguredUpstream("draft-source")).toBeUndefined();
  });

  it("keeps an empty valid result distinct from a failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ items: [] })));
    expect((await probe.probeConfiguredUpstream("custom-probe", "empty")).state).toBe("available");
  });

  it("reports redirects and network failures without following them", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 302, headers: { location: "http://127.0.0.1" } }));
    vi.stubGlobal("fetch", fetchMock);
    const redirect = await probe.probeConfiguredUpstream("custom-probe", "redirect");
    expect(redirect.state).toBe("error");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed", { cause: { code: "CERT_HAS_EXPIRED", message: "certificate expired" } })));
    const network = await probe.probeConfiguredUpstream("custom-probe", "network");
    expect(network.httpStatus).toBeNull();
    expect(network.message).toContain("fetch failed");
  });

  it("limits oversized responses and rejects unknown targets", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("x".repeat(1024 * 1024 + 1), { headers: { "content-type": "application/json" } })));
    expect((await probe.probeConfiguredUpstream("custom-probe", "large")).message).toContain("response JSON 解析失败");

    const mock = vi.fn();
    vi.stubGlobal("fetch", mock);
    await expect(probe.probeConfiguredUpstream("missing-source", "test")).rejects.toThrow("Unknown upstream");
    expect(mock).not.toHaveBeenCalled();
  });
});
