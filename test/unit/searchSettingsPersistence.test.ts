import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("server search settings SQLite persistence", () => {
  let dir = "";
  let service: typeof import("../../server/core/services/searchSettingsService");

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "panhub-search-settings-"));
    process.env.PANHUB_SQLITE_DB = join(dir, "panhub.sqlite");
    vi.resetModules();
    service = await import("../../server/core/services/searchSettingsService");
  });

  afterEach(async () => {
    delete process.env.PANHUB_SQLITE_DB;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  it("persists settings and keeps explicit null/empty values distinct", () => {
    service.saveSearchSettings({ channels: ["oldchan"], plugins: [], concurrency: 5 });
    expect(service.getSearchSettings()).toMatchObject({ channels: ["oldchan"], plugins: [], concurrency: 5 });
    expect(service.saveSearchSettings({ plugins: null }).plugins).toBeNull();
  });

  it("channel-only updates preserve plugin choices", () => {
    service.saveSearchSettings({ plugins: ["custom-upstream"], concurrency: 5 });
    const saved = service.saveSearchSettings({ channels: [] });
    expect(saved).toMatchObject({ plugins: ["custom-upstream"], concurrency: 5, channels: [] });
    saved.channels?.push("mutated");
    expect(service.getSearchSettings().channels).toEqual([]);
  });

  it("is visible to a fresh module instance through the same SQLite file", async () => {
    service.saveSearchSettings({ channels: ["diskchan"], pluginTimeoutMs: 9000 });
    vi.resetModules();
    const fresh = await import("../../server/core/services/searchSettingsService");
    expect(fresh.getSearchSettings()).toMatchObject({ channels: ["diskchan"], pluginTimeoutMs: 9000 });
    expect(fresh.getSearchSettingsVersion()).toBeTypeOf("string");
  });

  it("rejects invalid values without writing them", () => {
    service.saveSearchSettings({ channels: ["keepchan"], concurrency: 3 });
    const saved = service.saveSearchSettings({ channels: ["bad name!"], concurrency: 999 });
    expect(saved.channels).toEqual([]);
    expect(saved.concurrency).toBeNull();
  });
});
