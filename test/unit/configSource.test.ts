import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("creates only normalized configuration tables", async () => {
    const setup = await setupDatabase("panhub-config-source-schema-");
    dir = setup.dir;
    const storage = await import("../../server/core/storage/sqlite");
    const db = storage.getSqliteDatabase();

    const tables = db.allRows<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).map((row) => row.name);
    expect(tables).toContain("upstream_definitions");
    expect(tables).toContain("tg_channel_policies");
    expect(tables).not.toContain("legacy_kv");
    expect(tables).not.toContain("json_store");
    expect(tables).not.toContain("schema_meta");
  });

  it("TG setting mutations touch only their normalized rows", async () => {
    const setup = await setupDatabase("panhub-config-source-tg-");
    dir = setup.dir;
    const tgSettings = await import("../../server/core/services/tgChannelSettings");
    const storage = await import("../../server/core/storage/sqlite");
    const db = storage.getSqliteDatabase();

    tgSettings.setTgChannelState("offchan", { enabled: false });
    const stateBefore = db.getRow<{ updated_at: number }>(
      "SELECT updated_at FROM tg_channel_states WHERE channel=?",
      "offchan",
    )!.updated_at;

    tgSettings.saveTgChannelPolicies({ policydemo: { maxPages: 2 } });
    tgSettings.setUpstreamParser("source-demo", "parser-demo");

    expect(tgSettings.getTgChannelState("offchan")).toEqual({ enabled: false, deleted: false });
    expect(db.getRow<{ max_pages: number }>(
      "SELECT max_pages FROM tg_channel_policies WHERE channel=?",
      "policydemo",
    )?.max_pages).toBe(2);
    expect(db.getRow<{ plugin_id: string }>(
      "SELECT plugin_id FROM parser_bindings WHERE scope=? AND source_id=?",
      "upstream", "source-demo",
    )?.plugin_id).toBe("parser-demo");
    expect(db.getRow<{ updated_at: number }>(
      "SELECT updated_at FROM tg_channel_states WHERE channel=?",
      "offchan",
    )?.updated_at).toBe(stateBefore);
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
