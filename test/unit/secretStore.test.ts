import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("SqlitePluginSecretStore", () => {
  let dir = "";
  let dbPath = "";
  let store: InstanceType<typeof import("../../server/core/plugins/secretStore").SqlitePluginSecretStore>;
  let storage: typeof import("../../server/core/storage/sqlite");

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "panhub-secrets-"));
    dbPath = join(dir, "panhub.sqlite");
    process.env.PANHUB_SQLITE_DB = dbPath;
    process.env.PANHUB_LEGACY_DATA_DIR = dir;
    vi.resetModules();
    const secrets = await import("../../server/core/plugins/secretStore");
    store = new secrets.SqlitePluginSecretStore();
    storage = await import("../../server/core/storage/sqlite");
  });

  afterEach(async () => {
    storage.resetSqliteDatabase(dbPath);
    delete process.env.PANHUB_SQLITE_DB;
    delete process.env.PANHUB_LEGACY_DATA_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips values per plugin and persists them in SQLite", async () => {
    await store.set("plugin-a", "apiKey", "sk-abc");
    await store.set("plugin-a", "token", "tkn-1");

    expect(await store.list("plugin-a")).toEqual(["apiKey", "token"]);
    expect(await store.get("plugin-a", "apiKey")).toBe("sk-abc");
    expect(await store.get("plugin-b", "apiKey")).toBeNull();
    expect(await store.getMany("plugin-a", ["apiKey", "token", "missing"])).toEqual({
      apiKey: "sk-abc",
      token: "tkn-1",
    });
    expect(storage.getSqliteDatabase().getRow("SELECT value FROM plugin_secrets WHERE plugin_id=? AND name=?", "plugin-a", "apiKey"))
      .toEqual({ value: "sk-abc" });
  });

  it("deletes without touching other plugins or names", async () => {
    await store.set("a", "k", "v1");
    await store.set("b", "k", "v2");
    await store.delete("a", "k");

    expect(await store.get("a", "k")).toBeNull();
    expect(await store.get("b", "k")).toBe("v2");
    expect(await store.list("a")).toEqual([]);
  });
});
