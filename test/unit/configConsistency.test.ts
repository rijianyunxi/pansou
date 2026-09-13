import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstructionPluginDefinition } from "../../server/core/instructions/types";
import type { SearchPlugin } from "../../server/core/plugins/manager";

type SearchSettingsModule = typeof import("../../server/core/services/searchSettingsService");
type RepositoryModule = typeof import("../../server/core/plugins/repository");
type ManagerModule = typeof import("../../server/core/plugins/manager");

const definition = (
  version: string,
  url = "https://example.com/search"
): InstructionPluginDefinition => ({
  schemaVersion: 1,
  manifest: {
    id: "repo-fixture",
    name: "Repo fixture",
    version,
    kind: "instructions",
    priority: 1,
    timeoutMs: 1000,
    maxResults: 10,
    schemaVersion: 1,
    outputTypes: [],
  },
  request: { method: "GET", url },
  response: {
    format: "json",
    items: "items",
    fields: { title: "title" },
    links: { url: "url" },
  },
});

describe("SQLite configuration consistency", () => {
  let dir = "";
  let dbPath = "";
  let searchSettings: SearchSettingsModule;
  let repository: RepositoryModule;
  let manager: ManagerModule;
  let storage: typeof import("../../server/core/storage/sqlite");

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "panhub-config-consistency-"));
    dbPath = join(dir, "panhub.sqlite");
    process.env.PANHUB_SQLITE_DB = dbPath;
    vi.resetModules();
    [searchSettings, repository, manager, storage] = await Promise.all([
      import("../../server/core/services/searchSettingsService"),
      import("../../server/core/plugins/repository"),
      import("../../server/core/plugins/manager"),
      import("../../server/core/storage/sqlite"),
    ]);
  });

  afterEach(async () => {
    storage.resetSqliteDatabase(dbPath);
    delete process.env.PANHUB_SQLITE_DB;
    await rm(dir, { recursive: true, force: true });
  });

  it("returns empty settings from a fresh SQLite database", () => {
    expect(searchSettings.getSearchSettings()).toEqual({
      plugins: null,
      channels: null,
      concurrency: null,
      pluginTimeoutMs: null,
      trashedPlugins: [],
    });
    expect(searchSettings.getSearchSettingsVersion()).toBe("0:*:*");
  });

  it("persists search settings across fresh module instances", async () => {
    const saved = searchSettings.saveSearchSettings({
      channels: ["@achan", "bchan"],
      plugins: ["plugin-b", "plugin-a"],
      concurrency: 4,
      pluginTimeoutMs: 9000,
    });
    expect(saved).toMatchObject({
      channels: ["achan", "bchan"],
      plugins: ["plugin-b", "plugin-a"],
      concurrency: 4,
      pluginTimeoutMs: 9000,
    });
    expect(storage.getSqliteDatabase().getRow("SELECT concurrency,plugin_timeout_ms,plugins_configured,channels_configured FROM search_settings WHERE id=1"))
      .toEqual({ concurrency: 4, plugin_timeout_ms: 9000, plugins_configured: 1, channels_configured: 1 });

    storage.resetSqliteDatabase(dbPath);
    vi.resetModules();
    searchSettings = await import("../../server/core/services/searchSettingsService");
    storage = await import("../../server/core/storage/sqlite");
    expect(searchSettings.getSearchSettings()).toMatchObject({
      channels: ["achan", "bchan"],
      plugins: ["plugin-a", "plugin-b"],
      concurrency: 4,
      pluginTimeoutMs: 9000,
    });
    expect(searchSettings.getSearchSettingsVersion()).toBeTypeOf("string");
  });

  it("detects SQLite repository changes without filesystem polling", async () => {
    const repo = new repository.SqlitePluginRepository();
    const initialVersion = await repo.getConfigVersion();
    expect(initialVersion).toContain(":");
    expect(await repo.refreshIfChanged()).toBe(false);

    await repo.saveDraft(definition("1.0.0"), "alice");
    const changedVersion = await repo.getConfigVersion();
    expect(changedVersion).not.toBe(initialVersion);
    expect(await repo.refreshIfChanged()).toBe(false);

    storage.resetSqliteDatabase(dbPath);
    vi.resetModules();
    repository = await import("../../server/core/plugins/repository");
    storage = await import("../../server/core/storage/sqlite");
    const reloaded = new repository.SqlitePluginRepository();
    expect((await reloaded.get("repo-fixture"))?.updatedBy).toBe("alice");
    expect(await reloaded.getConfigVersion()).toBe(changedVersion);
  });

  it("adopts plugins published by another repository instance and keeps the registry on failure", async () => {
    const repo = new repository.SqlitePluginRepository();
    const pluginManager = new manager.PluginManager();
    const fakePlugin = (id: string, version = "1.0.0"): SearchPlugin => ({
      manifest: manager.definePluginManifest({ id, name: id, priority: 1, version }),
      search: async () => [],
    });
    pluginManager.register(fakePlugin("builtin"));

    let loads = 0;
    let failLoad = false;
    pluginManager.setUpdateSource({
      getRepositoryVersion: () => repo.getConfigVersion(),
      load: async () => {
        loads++;
        if (failLoad) throw new Error("repository unavailable");
        const records = await repo.list();
        return records
          .map(repository.resolvePublishedDefinition)
          .filter((value): value is InstructionPluginDefinition => !!value)
          .map((value) => fakePlugin(value.manifest.id, value.manifest.version));
      },
    });

    expect(await pluginManager.checkForUpdates()).toBe(false);
    expect(pluginManager.snapshot().plugins.map((plugin) => plugin.manifest.id)).toEqual(["builtin"]);

    const other = new repository.SqlitePluginRepository();
    await other.saveDraft(definition("1.0.0"), "other");
    await other.validate("repo-fixture", "other", { sampleParsed: true });
    await other.publish("repo-fixture", "other");

    expect(await pluginManager.checkForUpdates()).toBe(true);
    expect(pluginManager.snapshot().plugins.map((plugin) => plugin.manifest.id).sort()).toEqual(["builtin", "repo-fixture"]);
    const adoptedVersion = pluginManager.configVersion;
    expect(adoptedVersion).not.toBeNull();
    expect(await pluginManager.checkForUpdates()).toBe(false);
    expect(loads).toBe(2);
    expect(pluginManager.configVersion).toBe(adoptedVersion);

    await other.disable("repo-fixture", "other");
    expect(await pluginManager.checkForUpdates()).toBe(true);
    expect(pluginManager.snapshot().plugins.map((plugin) => plugin.manifest.id)).toEqual(["builtin"]);

    failLoad = true;
    await other.publish("repo-fixture", "other");
    await expect(pluginManager.checkForUpdates()).rejects.toThrow("repository unavailable");
    expect(pluginManager.snapshot().plugins.map((plugin) => plugin.manifest.id)).toEqual(["builtin"]);
    failLoad = false;
    expect(await pluginManager.checkForUpdates()).toBe(true);
    expect(pluginManager.snapshot().plugins.map((plugin) => plugin.manifest.id).sort()).toEqual(["builtin", "repo-fixture"]);
  });
});
