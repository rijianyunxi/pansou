import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JsonPluginRepository,
  resolvePublishedDefinition,
} from "../../server/core/plugins/repository";
import {
  definePluginManifest,
  PluginManager,
  type SearchPlugin,
} from "../../server/core/plugins/manager";
import type { InstructionPluginDefinition } from "../../server/core/instructions/types";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakePlugin(id: string, version = "1.0.0"): SearchPlugin {
  return {
    manifest: definePluginManifest({ id, name: id, priority: 1, version }),
    search: async () => [],
  };
}

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

describe("searchSettingsService cross-process consistency", () => {
  let dir = "";
  let service: typeof import("../../server/core/services/searchSettingsService");

  const loadService = async (recheckMs = "30") => {
    dir = await mkdtemp(join(tmpdir(), "panhub-config-consistency-"));
    process.env.PANHUB_SEARCH_SETTINGS_STORE = join(dir, "search-settings.json");
    process.env.PANHUB_SEARCH_SETTINGS_RECHECK_MS = recheckMs;
    vi.resetModules();
    service = await import("../../server/core/services/searchSettingsService");
  };

  afterEach(async () => {
    delete process.env.PANHUB_SEARCH_SETTINGS_STORE;
    delete process.env.PANHUB_SEARCH_SETTINGS_RECHECK_MS;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  it("picks up a settings file created by another process after the short TTL", async () => {
    await loadService();
    expect(service.getSearchSettings().channels).toBeNull();
    expect(service.getSearchSettingsVersion()).toBeNull();

    // "Another process" creates the store behind this instance's back.
    await writeFile(
      join(dir, "search-settings.json"),
      JSON.stringify({ channels: ["extchan"], concurrency: 4 }, null, 2),
      "utf-8"
    );
    await sleep(60); // one recheck window has elapsed
    const fresh = service.getSearchSettings();
    expect(fresh.channels).toEqual(["extchan"]);
    expect(fresh.concurrency).toBe(4);
    expect(service.getSearchSettingsVersion()).not.toBeNull();
  });

  it("reloads an existing store rewritten by another process", async () => {
    await loadService();
    const store = join(dir, "search-settings.json");
    await writeFile(store, JSON.stringify({ channels: ["achan"] }, null, 2), "utf-8");
    expect(service.getSearchSettings().channels).toEqual(["achan"]);

    // Rewrite with different content and a forced distinct mtime so the
    // detection never depends on filesystem timestamp granularity.
    await writeFile(
      store,
      JSON.stringify({ channels: ["bchan"], pluginTimeoutMs: 9000 }, null, 2),
      "utf-8"
    );
    await utimes(store, new Date(), new Date(Date.now() + 10_000));
    await sleep(60);
    const fresh = service.getSearchSettings();
    expect(fresh.channels).toEqual(["bchan"]);
    expect(fresh.pluginTimeoutMs).toBe(9000);
  });

  it("falls back to defaults when another process deletes the store file", async () => {
    await loadService();
    const store = join(dir, "search-settings.json");
    await writeFile(store, JSON.stringify({ channels: ["gonechan"] }, null, 2), "utf-8");
    expect(service.getSearchSettings().channels).toEqual(["gonechan"]);

    await unlink(store);
    await sleep(60);
    expect(service.getSearchSettings().channels).toBeNull();
  });

  it("keeps own saves immediately visible and refreshes the version stamp", async () => {
    await loadService();
    const saved = service.saveSearchSettings({ plugins: ["labi"], concurrency: 3 });
    expect(saved.plugins).toEqual(["labi"]);
    expect(service.getSearchSettings().plugins).toEqual(["labi"]);
    const version = service.getSearchSettingsVersion();
    expect(version).toBeTypeOf("string");

    // Different content length guarantees a new signature even on filesystems
    // with coarse mtime granularity.
    service.saveSearchSettings({ plugins: ["labi", "duoduo"] });
    expect(service.getSearchSettings().plugins).toEqual(["labi", "duoduo"]);
    expect(service.getSearchSettingsVersion()).not.toEqual(version);
  });
});

describe("JsonPluginRepository version checks", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  it("exposes a config version and detects external rewrites", async () => {
    dir = await mkdtemp(join(tmpdir(), "panhub-config-consistency-"));
    const store = join(dir, "plugins.json");
    const repo = new JsonPluginRepository(store);
    await repo.saveDraft(definition("1.0.0"), "alice");
    const versionBefore = await repo.getConfigVersion();
    expect(versionBefore).toBeTypeOf("string");
    expect(await repo.refreshIfChanged()).toBe(false);

    // "Another process" rewrites the store behind this instance's back
    // (longer updatedBy guarantees a different mtime+size signature).
    const raw = JSON.parse(await readFile(store, "utf-8"));
    raw.records["repo-fixture"].updatedBy = "other-process-".padEnd(40, "x");
    await writeFile(store, JSON.stringify(raw, null, 2) + "\n", "utf-8");

    expect(await repo.refreshIfChanged()).toBe(true);
    // No further change: the second check is a no-op.
    expect(await repo.refreshIfChanged()).toBe(false);
    expect((await repo.get("repo-fixture"))?.updatedBy).toContain("other-process");

    // Own writes refresh the baseline: no spurious external-change detection.
    await repo.audit("repo-fixture", "debugged", "local");
    expect(await repo.refreshIfChanged()).toBe(false);
    expect(await repo.getConfigVersion()).not.toEqual(versionBefore);
  });

  it("reports an unknown version while the store file does not exist", async () => {
    dir = await mkdtemp(join(tmpdir(), "panhub-config-consistency-"));
    const repo = new JsonPluginRepository(join(dir, "absent.json"));
    expect(await repo.getConfigVersion()).toBeNull();
    expect(await repo.refreshIfChanged()).toBe(false);
  });
});

describe("registry version check against the plugin repository", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  it("adopts plugins published by another process and keeps the registry on failure", async () => {
    dir = await mkdtemp(join(tmpdir(), "panhub-config-consistency-"));
    const store = join(dir, "plugins.json");
    const repo = new JsonPluginRepository(store);
    const manager = new PluginManager();
    manager.register(fakePlugin("builtin"));

    let loads = 0;
    let failLoad = false;
    manager.setUpdateSource({
      getRepositoryVersion: () => repo.getConfigVersion(),
      load: async () => {
        loads++;
        if (failLoad) throw new Error("repository unavailable");
        const records = await repo.list();
        return records
          .map(resolvePublishedDefinition)
          .filter((def): def is InstructionPluginDefinition => !!def)
          .map((def) => fakePlugin(def.manifest.id, def.manifest.version));
      },
    });

    // Nothing published yet: version unknown (missing file) → verify once, no churn.
    expect(await manager.checkForUpdates()).toBe(false);
    expect(manager.snapshot().plugins.map((plugin) => plugin.manifest.id)).toEqual(["builtin"]);

    // Another "process" publishes through a second repository instance.
    const other = new JsonPluginRepository(store);
    await other.saveDraft(definition("1.0.0"), "other");
    await other.validate("repo-fixture", "other", { sampleParsed: true });
    await other.publish("repo-fixture", "other");

    expect(await manager.checkForUpdates()).toBe(true);
    expect(manager.snapshot().plugins.map((plugin) => plugin.manifest.id).sort()).toEqual([
      "builtin",
      "repo-fixture",
    ]);
    const adoptedVersion = manager.configVersion;
    expect(adoptedVersion).not.toBeNull();

    // Unchanged file: stat-only check, loader skipped.
    expect(await manager.checkForUpdates()).toBe(false);
    expect(loads).toBe(2);
    expect(manager.configVersion).toEqual(adoptedVersion);

    // External disable removes the plugin from the registry snapshot.
    await other.disable("repo-fixture", "other");
    expect(await manager.checkForUpdates()).toBe(true);
    expect(manager.snapshot().plugins.map((plugin) => plugin.manifest.id)).toEqual(["builtin"]);

    // Refresh failure keeps the last valid registry; recovery applies the change.
    failLoad = true;
    await other.publish("repo-fixture", "other");
    await expect(manager.checkForUpdates()).rejects.toThrow("repository unavailable");
    expect(manager.snapshot().plugins.map((plugin) => plugin.manifest.id)).toEqual(["builtin"]);
    failLoad = false;
    expect(await manager.checkForUpdates()).toBe(true);
    expect(manager.snapshot().plugins.map((plugin) => plugin.manifest.id).sort()).toEqual([
      "builtin",
      "repo-fixture",
    ]);
  });
});
