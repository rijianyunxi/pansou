import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const customSource = {
  id: "custom-source",
  name: "自定义来源",
  url: "https://example.com/api/search",
  method: "GET" as const,
  format: "json" as const,
  description: "updated",
  transform: "function transform(payload, $, context) { return []; }",
};

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

  it("starts with an empty configured source catalog", () => {
    expect(catalog.listConfiguredUpstreams()).toEqual([]);
  });

  it("persists only administrator-provided source definitions", () => {
    const saved = catalog.saveConfiguredUpstream(customSource);
    expect(saved).toMatchObject({ id: "custom-source", enabled: true });
    expect(catalog.listConfiguredUpstreams().map((source) => source.id)).toEqual(["custom-source"]);
  });

  it("persists endpoint changes immediately", () => {
    const saved = catalog.saveConfiguredUpstream({ ...customSource, format: "html" });
    expect(saved).toMatchObject({ id: "custom-source", format: "html", enabled: true });
    expect(catalog.getConfiguredUpstream("CUSTOM-SOURCE")).toMatchObject(saved);
  });

  it("persists the canonical source address and request settings", () => {
    const saved = catalog.saveConfiguredUpstream({
      ...customSource,
      url: "https://example.com/search?q={{keyword}}",
      request: {
        url: "https://old.example.com/search",
        fallbackUrls: ["https://backup.example.com/search"],
        query: { q: "{{keyword}}" },
      },
    } as any);

    expect(saved.url).toBe("https://example.com/search?q={{keyword}}");
    expect(saved.request).toEqual({ query: { q: "{{keyword}}" } });
    expect(runtime.upstreamToInstructionDefinition(saved).request).toMatchObject({
      url: "https://example.com/search?q={{keyword}}",
      query: { q: "{{keyword}}" },
    });
  });

  it("changes the runtime version when the transform changes", () => {
    const source = catalog.saveConfiguredUpstream(customSource);
    const before = runtime.upstreamToInstructionDefinition(source).manifest.version;
    const updated = catalog.saveConfiguredUpstream({
      ...source,
      transform: "function transform(payload, $, context) { return [{ title: context.keyword }]; }",
    });
    const after = runtime.upstreamToInstructionDefinition(updated).manifest.version;
    expect(after).not.toBe(before);
  });

  it("keeps configuration version changes visible to the next request", () => {
    catalog.saveConfiguredUpstream(customSource);
    const before = catalog.getConfiguredUpstreamVersion();
    catalog.saveConfiguredUpstream({ ...customSource, url: "https://example.com/other" });
    expect(catalog.getConfiguredUpstreamVersion()).not.toBe(before);
  });

  it("deletes configured sources without resurrecting them", () => {
    catalog.saveConfiguredUpstream(customSource);
    catalog.deleteConfiguredUpstream("custom-source");
    expect(catalog.getConfiguredUpstream("custom-source")).toBeUndefined();
    expect(catalog.listConfiguredUpstreams()).toEqual([]);
    const restored = catalog.saveConfiguredUpstream({ ...customSource, name: "自定义来源 restored" });
    expect(restored.name).toBe("自定义来源 restored");
  });

  it("disables a configured source without deleting its configuration", () => {
    catalog.saveConfiguredUpstream(customSource);
    const disabled = catalog.setConfiguredUpstreamEnabled("custom-source", false);
    expect(disabled.enabled).toBe(false);
    expect(catalog.getConfiguredUpstream("custom-source")).toMatchObject({ enabled: false });
  });

  it("rejects unsafe or incomplete configuration", () => {
    expect(() => catalog.saveConfiguredUpstream({ ...customSource, url: "http://example.com/search" })).toThrow(/HTTPS/);
    expect(() => catalog.saveConfiguredUpstream({ ...customSource, method: "PUT" as any })).toThrow(/请求方式/);
  });
});
