import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("SQLite upstream catalog", () => {
  let dir = "";
  let dbPath = "";
  let catalog: typeof import("../../server/core/services/upstreamCatalog");
  let storage: typeof import("../../server/core/storage/sqlite");
  let runtime: typeof import("../../server/core/services/configuredUpstreamPlugin");

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "panhub-upstream-catalog-"));
    dbPath = join(dir, "panhub.sqlite");
    process.env.PANHUB_SQLITE_DB = dbPath;
    vi.resetModules();
    catalog = await import("../../server/core/services/upstreamCatalog");
    storage = await import("../../server/core/storage/sqlite");
    runtime = await import("../../server/core/services/configuredUpstreamPlugin");
  });

  afterEach(async () => {
    storage.resetSqliteDatabase(dbPath);
    delete process.env.PANHUB_SQLITE_DB;
    await rm(dir, { recursive: true, force: true });
  });

  it("seeds the configured source catalog on first read", () => {
    const sources = catalog.listConfiguredUpstreams();
    expect(sources.map((source) => source.id).sort()).toEqual([
      "duoduo",
      "hunhepan",
      "nyaa",
      "pansearch",
    ]);
    expect(sources.every((source) => source.builtin)).toBe(true);
  });

  it("keeps seeded Core capabilities compatible after SQLite normalization", () => {
    for (const id of ["hunhepan", "nyaa", "pansearch", "duoduo"]) {
      expect(runtime.isCoreCompatibleConfiguration(catalog.getConfiguredUpstream(id)!)).toBe(true);
    }

    const source = catalog.getConfiguredUpstream("hunhepan")!;
    catalog.saveConfiguredUpstream({ ...source, description: "仅修改说明" });
    expect(runtime.isCoreCompatibleConfiguration(catalog.getConfiguredUpstream("hunhepan")!)).toBe(true);

    catalog.saveConfiguredUpstream({ ...source, url: "https://example.com/api/search" });
    expect(runtime.isCoreCompatibleConfiguration(catalog.getConfiguredUpstream("hunhepan")!)).toBe(false);
  });

  it("persists endpoint, method and format changes immediately", () => {
    const saved = catalog.saveConfiguredUpstream({
      id: "hunhepan",
      name: "自定义混合盘",
      url: "https://example.com/api/search",
      method: "GET",
      format: "html",
      description: "updated",
      builtin: false,
    });

    expect(saved).toMatchObject({
      id: "hunhepan",
      name: "自定义混合盘",
      url: "https://example.com/api/search",
      method: "GET",
      format: "html",
      builtin: true,
      enabled: true,
    });
    expect(catalog.getConfiguredUpstream("HUNHEPAN")).toMatchObject(saved);
  });

  it("seeds every shipped source with a function transform and request definition", () => {
    const sources = catalog.listConfiguredUpstreams();
    const hunhepan = sources.find((source) => source.id === "hunhepan")!;
    const nyaa = sources.find((source) => source.id === "nyaa")!;
    const pansearch = sources.find((source) => source.id === "pansearch")!;
    expect(hunhepan.transform).toMatch(/function transform/);
    expect(hunhepan.request?.body).toMatchObject({ q: "{{keyword}}" });
    expect(nyaa.transform).toMatch(/function transform/);
    expect(nyaa.request?.query).toMatchObject({ q: "{{keyword}}" });
    expect(pansearch.transform).toMatch(/function transform/);
    expect(pansearch.format).toBe("json");
    expect(pansearch.request?.stages).toHaveLength(1);
    expect(runtime.isCoreCompatibleConfiguration(hunhepan)).toBe(true);
  });

  it("changes the runtime version when the transform changes", () => {
    const before = runtime.upstreamToInstructionDefinition(catalog.getConfiguredUpstream("hunhepan")!).manifest.version;
    catalog.saveConfiguredUpstream({
      ...catalog.getConfiguredUpstream("hunhepan")!,
      transform: "function transform(payload, $, context) { return []; }",
    });
    const after = runtime.upstreamToInstructionDefinition(catalog.getConfiguredUpstream("hunhepan")!).manifest.version;
    expect(after).not.toBe(before);
  });

  it("keeps configuration version changes visible to the next request", () => {
    const before = catalog.getConfiguredUpstreamVersion();
    expect(catalog.getConfiguredUpstreamVersion()).toBe(before);
    catalog.saveConfiguredUpstream({
      id: "nyaa",
      url: "https://example.com/nyaa",
      method: "GET",
      format: "html",
    });
    const after = catalog.getConfiguredUpstreamVersion();
    expect(after).not.toBe(before);
  });

  it("deletes configured sources without resurrecting them from shipped seeds", () => {
    catalog.deleteConfiguredUpstream("nyaa");
    expect(catalog.getConfiguredUpstream("nyaa")).toBeUndefined();
    expect(catalog.listConfiguredUpstreams().some((source) => source.id === "nyaa")).toBe(false);

    const restored = catalog.saveConfiguredUpstream({
      id: "nyaa",
      name: "Nyaa restored",
      url: "https://nyaa.si/",
      method: "GET",
      format: "html",
      transform: "function transform(payload, $, context) { return []; }",
    });
    expect(restored.name).toBe("Nyaa restored");
    expect(catalog.getConfiguredUpstream("nyaa")).toMatchObject({ name: "Nyaa restored" });
  });

  it("disables a configured source without deleting its configuration", () => {
    const disabled = catalog.setConfiguredUpstreamEnabled("duoduo", false);
    expect(disabled.enabled).toBe(false);
    expect(catalog.getConfiguredUpstream("duoduo")).toMatchObject({ enabled: false });
  });

  it("rejects unsafe or incomplete configuration", () => {
    expect(() => catalog.saveConfiguredUpstream({
      id: "unsafe",
      name: "unsafe",
      url: "http://example.com/search",
      method: "GET",
      format: "json",
    })).toThrow(/HTTPS/);
    expect(() => catalog.saveConfiguredUpstream({
      id: "unsafe",
      name: "unsafe",
      url: "https://example.com/search",
      method: "PUT",
      format: "json",
    })).toThrow(/请求方式/);
  });
});
