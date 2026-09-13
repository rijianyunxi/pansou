import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function setupDatabase(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const dbPath = join(dir, "panhub.sqlite");
  process.env.PANHUB_SQLITE_DB = dbPath;
  vi.resetModules();
  return { dir, dbPath };
}

describe("formal configuration sources", () => {
  let dir = "";

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.PANHUB_SQLITE_DB;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  it("upstream catalog reads structured rows without using the KV adapter", async () => {
    const setup = await setupDatabase("panhub-config-source-upstream-");
    dir = setup.dir;
    const catalog = await import("../../server/core/services/upstreamCatalog");
    const storage = await import("../../server/core/storage/sqlite");
    const db = storage.getSqliteDatabase();
    const seeded = catalog.getConfiguredUpstream("hunhepan")!;

    vi.spyOn(db, "get").mockImplementation(() => { throw new Error("legacy get must not be used"); });
    vi.spyOn(db, "set").mockImplementation(() => { throw new Error("legacy set must not be used"); });
    vi.spyOn(db, "getUpdatedAt").mockImplementation(() => { throw new Error("legacy timestamp must not be used"); });

    const updated = catalog.saveConfiguredUpstream({
      ...seeded,
      url: "https://structured.example/search",
    });
    expect(catalog.getConfiguredUpstream("hunhepan")?.url).toBe(updated.url);

    db.run(
      "INSERT INTO legacy_kv(namespace,key,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
      "upstream_catalog",
      "definitions",
      JSON.stringify({ hunhepan: { ...seeded, url: "https://legacy.example/search" } }),
      Date.now(),
    );
    expect(catalog.getConfiguredUpstream("hunhepan")?.url).toBe("https://structured.example/search");
  });

  it("TG channel settings read and write structured tables without the KV adapter", async () => {
    const setup = await setupDatabase("panhub-config-source-tg-");
    dir = setup.dir;
    const tgSettings = await import("../../server/core/services/tgChannelSettings");
    const storage = await import("../../server/core/storage/sqlite");
    const db = storage.getSqliteDatabase();

    tgSettings.setTgChannelState("offchan", { enabled: false });
    vi.spyOn(db, "get").mockImplementation(() => { throw new Error("legacy get must not be used"); });
    vi.spyOn(db, "set").mockImplementation(() => { throw new Error("legacy set must not be used"); });
    vi.spyOn(db, "getUpdatedAt").mockImplementation(() => { throw new Error("legacy timestamp must not be used"); });

    expect(tgSettings.getTgChannelState("offchan")).toEqual({ enabled: false, deleted: false });
    expect(tgSettings.getTgChannelSettingsVersion()).toContain("offchan");
    tgSettings.saveTgChannelPolicies({ policydemo: { maxPages: 2 } });
    expect(db.getRow<{ max_pages: number }>("SELECT max_pages FROM tg_channel_policies WHERE channel=?", "policydemo")?.max_pages).toBe(2);
  });

  it("search defaults use system settings from SQLite when channels are unset", async () => {
    const setup = await setupDatabase("panhub-config-source-search-");
    dir = setup.dir;
    vi.stubGlobal("useRuntimeConfig", () => ({
      defaultChannels: ["runtimeonly"],
      priorityChannels: [],
      defaultConcurrency: 2,
      pluginTimeoutMs: 2000,
      cacheTtlMinutes: 99,
    }));
    const system = await import("../../server/core/services/systemSettingsService");
    const searchSettings = await import("../../server/core/services/searchSettingsService");
    const defaults = await import("../../server/utils/searchDefaults");

    system.saveSystemSettings({
      priorityChannels: [],
      defaultChannels: ["sqliteonly"],
      defaultConcurrency: 4,
      pluginTimeoutMs: 5000,
      cacheTtlMinutes: 7,
    });
    searchSettings.saveSearchSettings({ channels: null });

    expect(defaults.applySearchDefaults({}).channels).toEqual(["sqliteonly"]);
  });

  it("search service cache TTL comes from system settings rather than runtime overrides", async () => {
    const setup = await setupDatabase("panhub-config-source-service-");
    dir = setup.dir;
    const system = await import("../../server/core/services/systemSettingsService");
    system.saveSystemSettings({
      priorityChannels: [],
      defaultChannels: [],
      defaultConcurrency: 2,
      pluginTimeoutMs: 3000,
      cacheTtlMinutes: 7,
    });
    const services = await import("../../server/core/services");
    services.resetSearchService();
    services.getOrCreateSearchService({
      priorityChannels: [],
      defaultChannels: ["runtimeonly"],
      defaultConcurrency: 9,
      pluginTimeoutMs: 9000,
      searchTimeoutMs: 10_000,
      cacheEnabled: true,
      cacheTtlMinutes: 99,
    });

    expect(services.getSearchServiceStats().options?.cacheTtlMinutes).toBe(7);
  });
});
