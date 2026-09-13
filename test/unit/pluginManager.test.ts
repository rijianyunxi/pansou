import { describe, expect, it } from "vitest";
import {
  CodeSearchPlugin,
  PluginManager,
  definePluginManifest,
  type PluginSearchContext,
} from "../../server/core/plugins/manager";
import type { SearchResult } from "../../server/core/types/models";

class TestPlugin extends CodeSearchPlugin {
  constructor(id: string, priority = 1, version = "1.0.0") {
    super({ id, name: id, priority, version });
  }

  async search(context: PluginSearchContext): Promise<SearchResult[]> {
    return [{
      message_id: `${this.manifest.id}-1`,
      unique_id: `${this.manifest.id}-1`,
      channel: this.manifest.id,
      datetime: new Date().toISOString(),
      title: `${this.manifest.id}: ${context.keyword}`,
      content: "test",
      links: [{ type: "quark", url: `https://example.com/${this.manifest.id}`, password: "" }],
    }];
  }
}

describe("PluginManifest", () => {
  it("creates deeply immutable metadata with defaults", () => {
    const manifest = definePluginManifest({ id: "test", name: "Test", priority: 3 });
    expect(manifest).toMatchObject({ id: "test", version: "1.0.0", kind: "code", maxResults: 200 });
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.outputTypes)).toBe(true);
  });
});

describe("PluginManager", () => {
  it("registers plugins and rejects duplicate ids", () => {
    const manager = new PluginManager();
    manager.register(new TestPlugin("one"));
    expect(manager.get("one")?.manifest.id).toBe("one");
    expect(() => manager.register(new TestPlugin("one"))).toThrow(/already registered/);
  });

  it("supports atomic replacement, enable/disable and unregister", () => {
    const manager = new PluginManager();
    const first = new TestPlugin("one", 1, "1.0.0");
    manager.register(first);
    manager.replace(new TestPlugin("one", 1, "2.0.0"));
    expect(manager.get("one")?.manifest.version).toBe("2.0.0");
    expect(manager.disable("one")).toBe(true);
    expect(manager.list()).toEqual([]);
    expect(manager.list({ includeDisabled: true })).toHaveLength(1);
    expect(manager.enable("one")).toBe(true);
    expect(manager.unregister("one")).toBe(true);
    expect(manager.get("one")).toBeUndefined();
  });

  it("keeps previous snapshots immutable across atomic refreshes", () => {
    const manager = new PluginManager();
    manager.register(new TestPlugin("static"));
    const before = manager.snapshot();
    manager.replaceMany([new TestPlugin("dynamic", 2)], []);
    const after = manager.snapshot();
    expect(before.plugins.map((plugin) => plugin.manifest.id)).toEqual(["static"]);
    expect(after.plugins.map((plugin) => plugin.manifest.id)).toEqual(["static", "dynamic"]);
    expect(after.version).toBeGreaterThan(before.version);
    expect(() => (before.plugins as SearchPluginForMutation[]).push(new TestPlugin("bad"))).toThrow();
  });
});

describe("PluginManager.checkForUpdates", () => {
  it("returns false when no update source is configured", async () => {
    expect(await new PluginManager().checkForUpdates()).toBe(false);
  });

  it("applies updates when the repository version changes and skips the loader otherwise", async () => {
    const manager = new PluginManager();
    manager.register(new TestPlugin("builtin"));
    let loads = 0;
    manager.setUpdateSource({
      getRepositoryVersion: async () => "v1",
      load: async () => {
        loads++;
        return [new TestPlugin("dyn-a"), new TestPlugin("dyn-b")];
      },
    });
    expect(await manager.checkForUpdates()).toBe(true);
    expect(manager.snapshot().plugins.map((plugin) => plugin.manifest.id)).toEqual([
      "builtin",
      "dyn-a",
      "dyn-b",
    ]);
    expect(manager.configVersion).toBe("v1");

    // Unchanged version: cheap stat-only comparison, loader not invoked.
    expect(await manager.checkForUpdates()).toBe(false);
    expect(loads).toBe(1);
  });

  it("removes managed plugins that disappear from a fresh load", async () => {
    const manager = new PluginManager();
    manager.register(new TestPlugin("builtin"));
    let current: TestPlugin[] = [new TestPlugin("dyn-a"), new TestPlugin("dyn-b")];
    manager.setUpdateSource({
      // Unknown version falls back to verifying the loaded set every check.
      getRepositoryVersion: async () => null,
      load: async () => current,
    });
    await manager.checkForUpdates();
    current = [new TestPlugin("dyn-a")];
    expect(await manager.checkForUpdates()).toBe(true);
    expect(manager.snapshot().plugins.map((plugin) => plugin.manifest.id)).toEqual([
      "builtin",
      "dyn-a",
    ]);
    expect(manager.list({ includeDisabled: true })).toHaveLength(2);
  });

  it("keeps the last valid registry when the refresh fails", async () => {
    const manager = new PluginManager();
    let shouldFail = false;
    let version = "v1";
    let loaded: TestPlugin[] = [new TestPlugin("dyn")];
    manager.setUpdateSource({
      getRepositoryVersion: async () => version,
      load: async () => {
        if (shouldFail) throw new Error("repository unavailable");
        return loaded;
      },
    });
    await manager.checkForUpdates();
    const goodSnapshot = manager.snapshot();

    shouldFail = true;
    version = "v2";
    await expect(manager.checkForUpdates()).rejects.toThrow("repository unavailable");
    // Failed refresh: same frozen snapshot keeps serving, baseline not advanced.
    expect(manager.snapshot()).toBe(goodSnapshot);
    expect(manager.configVersion).toBe("v1");

    // Recovery: the source is available again with new content.
    shouldFail = false;
    loaded = [new TestPlugin("dyn"), new TestPlugin("dyn-extra")];
    expect(await manager.checkForUpdates()).toBe(true);
    expect(manager.configVersion).toBe("v2");
    expect(manager.snapshot().plugins.map((plugin) => plugin.manifest.id)).toEqual([
      "dyn",
      "dyn-extra",
    ]);
  });

  it("verifies the loaded set on every check without churn when the version is unknown", async () => {
    const manager = new PluginManager();
    let loads = 0;
    manager.setUpdateSource({
      getRepositoryVersion: async () => null,
      load: async () => {
        loads++;
        return [];
      },
    });
    expect(await manager.checkForUpdates()).toBe(false);
    expect(await manager.checkForUpdates()).toBe(false);
    expect(loads).toBe(2);
    // No dynamic plugins to apply: the registry snapshot is never committed.
    expect(manager.snapshot().version).toBe(0);
  });

  it("shares a single in-flight check between concurrent callers", async () => {
    const manager = new PluginManager();
    let loads = 0;
    manager.setUpdateSource({
      getRepositoryVersion: async () => null,
      load: async () => {
        loads++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [new TestPlugin("dyn")];
      },
    });
    const [first, second] = await Promise.all([
      manager.checkForUpdates(),
      manager.checkForUpdates(),
    ]);
    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(loads).toBe(1);
  });
});

type SearchPluginForMutation = TestPlugin;
