import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("configured upstream probe", () => {
  let dir = "";
  let dbPath = "";
  let catalog: typeof import("../../server/core/services/upstreamCatalog");
  let probe: typeof import("../../server/core/services/upstreamProbe");
  let storage: typeof import("../../server/core/storage/sqlite");
  let dnsGuard: typeof import("../../server/core/security/dnsGuard");

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "panhub-configured-probe-"));
    dbPath = join(dir, "panhub.sqlite");
    process.env.PANHUB_SQLITE_DB = dbPath;
    vi.resetModules();
    catalog = await import("../../server/core/services/upstreamCatalog");
    probe = await import("../../server/core/services/upstreamProbe");
    storage = await import("../../server/core/storage/sqlite");
    dnsGuard = await import("../../server/core/security/dnsGuard");
    // This test replaces fetch; disable real DNS resolution so the security
    // boundary does not turn example.com into an external dependency.
    dnsGuard.setHostResolver(null);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    dnsGuard.setHostResolver(undefined);
    storage.resetSqliteDatabase(dbPath);
    delete process.env.PANHUB_SQLITE_DB;
    await rm(dir, { recursive: true, force: true });
  });

  it("uses the edited catalog request and mapping instead of the legacy Core request", async () => {
    const source = await catalog.saveConfiguredUpstream({
      id: "edited-source",
      name: "Edited source",
      description: "",
      url: "https://example.com/legacy",
      method: "GET",
      format: "json",
      plugin: "edited-source",
      adapter: "json-mapping",
      mapping: { items: "items", title: "title", url: "url", type: "type", password: "password" },
      transform: "function transform(payload, $, context) { return payload.items || []; }",
    });
    await catalog.saveConfiguredUpstream({
      ...source,
      url: "https://example.com/api/search",
      method: "POST",
      format: "json",
      adapter: "json-mapping",
      mapping: {
        items: "items",
        title: "title",
        url: "url",
        type: "type",
        password: "password",
      },
      request: {
        bodyType: "json",
        body: { query: "{{keyword}}", page: 1 },
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      items: [{ title: "configured", url: "https://pan.quark.cn/s/configured", type: "quark" }],
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await probe.probeConfiguredUpstream("edited-source", "三体");
    expect(result.state).toBe("available");
    expect(result.results[0]?.title).toBe("configured");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://example.com/api/search");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST", redirect: "manual" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ query: "三体", page: 1 });
  });
});
