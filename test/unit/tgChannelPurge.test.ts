import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Telegram channel permanent deletion", () => {
  let dir = "";
  let dbPath = "";

  afterEach(async () => {
    try {
      const storage = await import("../../server/core/storage/sqlite");
      if (dbPath) storage.resetSqliteDatabase(dbPath);
    } catch { /* database was not opened */ }
    delete process.env.PANHUB_SQLITE_DB;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
    dbPath = "";
    vi.resetModules();
  });

  it("removes an archived channel from config, bindings, health history, and source catalog", async () => {
    dir = await mkdtemp(join(tmpdir(), "panhub-tg-purge-"));
    dbPath = join(dir, "panhub.sqlite");
    process.env.PANHUB_SQLITE_DB = dbPath;
    vi.resetModules();

    const system = await import("../../server/core/services/systemSettingsService");
    const searchSettings = await import("../../server/core/services/searchSettingsService");
    const tgSettings = await import("../../server/core/services/tgChannelSettings");
    const storage = await import("../../server/core/storage/sqlite");
    const db = storage.getSqliteDatabase();

    system.saveSystemSettings({
      priorityChannels: ["purgeme", "keepchan"],
      defaultChannels: ["purgeme", "keepchan"],
      defaultConcurrency: 4,
      pluginTimeoutMs: 5000,
      cacheTtlMinutes: 7,
    });
    searchSettings.saveSearchSettings({ channels: ["purgeme", "customkeep"] });
    tgSettings.saveTgChannelPolicies({ purgeme: { maxPages: 2 } });
    tgSettings.setTgChannelParser("purgeme", "parser-demo");
    tgSettings.setTgChannelState("purgeme", { deleted: true });
    db.run(
      "INSERT INTO tg_channel_health(channel,checked_at,ok,elapsed_ms,results_count,source) VALUES(?,?,?,?,?,?)",
      "purgeme", 1, 1, 10, 2, "probe",
    );
    db.run(
      "INSERT INTO upstream_definitions(id,source_kind,channel,name,description,url,method,format,enabled,definition,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      "tg-purgeme", "telegram", "purgeme", "@purgeme", "Telegram", "https://t.me/s/purgeme", "GET", "html", 0, "{}", 1,
    );

    const purged = tgSettings.purgeTgChannel("@PurgeMe");
    expect(purged).toMatchObject({
      channel: "purgeme",
      removedSystemEntries: 2,
      removedSearchEntries: 1,
      removedPolicy: true,
      removedParserBindings: 1,
      removedHealthRecords: 1,
      removedUpstreamDefinitions: 1,
    });
    expect(system.getSystemSettings({}).defaultChannels).toEqual(["keepchan"]);
    expect(system.getSystemSettings({}).priorityChannels).toEqual(["keepchan"]);
    expect(searchSettings.getSearchSettings().channels).toEqual(["customkeep"]);
    expect(tgSettings.getTgChannelState("purgeme")).toBeUndefined();
    expect(tgSettings.getTgChannelPolicy("purgeme")).toBeUndefined();
    expect(tgSettings.getTgChannelParsers().purgeme).toBeUndefined();
    expect(db.getRow("SELECT channel FROM tg_channel_health WHERE channel=?", "purgeme")).toBeUndefined();
    expect(db.getRow("SELECT id FROM upstream_definitions WHERE id=?", "tg-purgeme")).toBeUndefined();
    expect(db.allRows("SELECT name,position FROM system_channels WHERE kind='default'")).toEqual([{ name: "keepchan", position: 0 }]);
    expect(db.allRows("SELECT channel,position FROM search_setting_channels")).toEqual([{ channel: "customkeep", position: 0 }]);
    expect(() => tgSettings.purgeTgChannel("keepchan")).toThrow("must be archived");
  });
});
