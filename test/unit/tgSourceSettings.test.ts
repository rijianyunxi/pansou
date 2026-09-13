import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("TG source settings", () => {
  let dir = "";
  let dbPath = "";
  let settings: typeof import("../../server/core/services/tgSourceSettings");
  let storage: typeof import("../../server/core/storage/sqlite");

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "panhub-tg-source-"));
    dbPath = join(dir, "panhub.sqlite");
    process.env.PANHUB_SQLITE_DB = dbPath;
    vi.resetModules();
    const modules = await import("../../server/core/services/tgSourceSettings");
    settings = modules;
    storage = await import("../../server/core/storage/sqlite");
  });

  afterEach(async () => {
    storage.resetSqliteDatabase(dbPath);
    delete process.env.PANHUB_SQLITE_DB;
    await rm(dir, { recursive: true, force: true });
  });

  it("seeds the current direct and Jina routes", () => {
    expect(settings.buildConfiguredTgUrl("direct", "@Demo_Channel", "三体", "123")).toBe(
      "https://t.me/s/Demo_Channel?q=%E4%B8%89%E4%BD%93&before=123",
    );
    expect(settings.buildConfiguredTgUrl("jina", "Demo_Channel", "三体", "123")).toBe(
      "https://r.jina.ai/https://t.me/s/Demo_Channel?q=%E4%B8%89%E4%BD%93&before=123",
    );
  });

  it("persists route templates and applies them on the next URL build", () => {
    settings.saveTgSourceSettings({
      directTemplate: "https://tg.example.com/channel/{{channel}}",
      jinaTemplate: "https://reader.example.com/http://tg.example.com/channel/{{channel}}",
      userAgent: "Test Agent",
    });
    expect(settings.buildConfiguredTgUrl("direct", "demo", "hello")).toBe(
      "https://tg.example.com/channel/demo?q=hello",
    );
    expect(settings.getTgSourceSettings().userAgent).toBe("Test Agent");
    expect(settings.getTgSourceSettingsVersion()).toContain("Test Agent");
  });

  it("rejects templates without a channel placeholder or unsafe protocol", () => {
    expect(() => settings.saveTgSourceSettings({ directTemplate: "https://example.com/search" })).toThrow(/channel/);
    expect(() => settings.saveTgSourceSettings({ directTemplate: "http://example.com/{{channel}}" })).toThrow(/协议/);
  });
});
