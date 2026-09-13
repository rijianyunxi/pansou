import { describe, expect, it } from "vitest";
import { SearchService } from "../../server/core/services/searchService";
import {
  CodeSearchPlugin,
  PluginManager,
  type PluginSearchContext,
} from "../../server/core/plugins/manager";
import type { SearchResult } from "../../server/core/types/models";

class ThrowingPlugin extends CodeSearchPlugin {
  async search(_context: PluginSearchContext): Promise<SearchResult[]> {
    throw new Error("plugin exploded");
  }
}

class SuccessPlugin extends CodeSearchPlugin {
  async search(_context: PluginSearchContext): Promise<SearchResult[]> {
    return [
      {
        message_id: "1",
        unique_id: "ok-1",
        channel: "success-plugin",
        datetime: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        title: "ok result",
        content: "ok result",
        links: [{ type: "quark", url: "https://example.com/1", password: "" }],
      },
    ];
  }
}

class EmptyPlugin extends CodeSearchPlugin {
  async search(_context: PluginSearchContext): Promise<SearchResult[]> {
    return [];
  }
}

class FallbackPlugin extends CodeSearchPlugin {
  async search(context: PluginSearchContext): Promise<SearchResult[]> {
    const { keyword } = context;
    if (keyword === "movie") {
      return [
        {
          message_id: "fallback-1",
          unique_id: "fallback-1",
          channel: "fallback-plugin",
          datetime: new Date("2026-01-01T00:00:00.000Z").toISOString(),
          title: "fallback result",
          content: "fallback result",
          links: [{ type: "quark", url: "https://example.com/fallback", password: "" }],
        },
      ];
    }

    return [];
  }
}


class TimeoutPlugin extends CodeSearchPlugin {
  observedSignal?: AbortSignal;
  abortReason?: unknown;

  async search(context: PluginSearchContext): Promise<SearchResult[]> {
    this.observedSignal = context.signal;
    return new Promise<SearchResult[]>((_, reject) => {
      context.signal.addEventListener(
        "abort",
        () => {
          this.abortReason = context.signal.reason;
          reject(context.signal.reason);
        },
        { once: true }
      );
    });
  }
}

class VariantMergePlugin extends CodeSearchPlugin {
  async search(context: PluginSearchContext): Promise<SearchResult[]> {
    const { keyword } = context;
    if (keyword === "肖申克的救赎") {
      return [
        {
          message_id: "variant-1",
          unique_id: "variant-1",
          channel: "variant-plugin",
          datetime: new Date("2026-01-01T00:00:00.000Z").toISOString(),
          title: "肖申克的救赎",
          content: "exact",
          links: [{ type: "quark", url: "https://example.com/exact", password: "" }],
        },
      ];
    }

    if (keyword === "肖申克 救赎") {
      return [
        {
          message_id: "variant-2",
          unique_id: "variant-2",
          channel: "variant-plugin",
          datetime: new Date("2026-01-02T00:00:00.000Z").toISOString(),
          title: "肖申克 救赎 导演剪辑版",
          content: "variant",
          links: [{ type: "quark", url: "https://example.com/variant", password: "" }],
        },
      ];
    }

    return [];
  }
}

function createService(plugin: CodeSearchPlugin) {
  const manager = new PluginManager();
  manager.register(plugin);

  return new SearchService(
    {
      priorityChannels: [],
      defaultChannels: [],
      defaultConcurrency: 2,
      pluginTimeoutMs: 100,
      cacheEnabled: false,
      cacheTtlMinutes: 1,
    },
    manager
  );
}

function createServiceWithPlugins(plugins: CodeSearchPlugin[]) {
  const manager = new PluginManager();
  for (const plugin of plugins) {
    manager.register(plugin);
  }

  return new SearchService(
    {
      priorityChannels: [],
      defaultChannels: [],
      defaultConcurrency: 2,
      pluginTimeoutMs: 100,
      cacheEnabled: false,
      cacheTtlMinutes: 1,
    },
    manager
  );
}

describe("SearchService warnings", () => {
  it("returns warnings for the current failed search", async () => {
    const service = createService(new ThrowingPlugin({ id: "thrower", name: "thrower", priority: 1 }));

    const result = await service.searchWithWarnings(
      "test",
      [],
      1,
      false,
      "links",
      "plugin",
      ["thrower"],
      undefined,
      {}
    );

    expect(result.response.total).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.source).toBe("thrower");
  });

  it("does not leak warnings into the next successful search", async () => {
    const service = createServiceWithPlugins([
      new ThrowingPlugin({ id: "thrower", name: "thrower", priority: 1 }),
      new SuccessPlugin({ id: "success", name: "success", priority: 1 }),
    ]);

    await service.searchWithWarnings(
      "test",
      [],
      1,
      false,
      "links",
      "plugin",
      ["thrower"],
      undefined,
      {}
    );

    const result = await service.searchWithWarnings(
      "test",
      [],
      1,
      false,
      "links",
      "plugin",
      ["success"],
      undefined,
      {}
    );

    expect(result.response.total).toBe(1);
    expect(result.warnings).toEqual([]);
  });

  it("does not mark a plugin unhealthy when it simply returns no results", async () => {
    const service = createService(new EmptyPlugin({ id: "empty", name: "empty", priority: 1 }));

    for (let i = 0; i < 6; i++) {
      const result = await service.searchWithWarnings(
        `miss-${i}`,
        [],
        1,
        false,
        "links",
        "plugin",
        ["empty"],
        undefined,
        {}
      );

      expect(result.response.total).toBe(0);
    }

    const status = service.getPluginHealthStatus().find((item) => item.name === "empty");
    expect(status?.isHealthy).toBe(true);
    expect(status?.failureCount).toBe(0);
  });

  it("does not count a successful fallback search as a plugin failure", async () => {
    const service = createService(new FallbackPlugin({ id: "fallback", name: "fallback", priority: 1 }));

    const result = await service.searchWithWarnings(
      "a",
      [],
      1,
      false,
      "links",
      "plugin",
      ["fallback"],
      undefined,
      {}
    );

    expect(result.response.total).toBe(1);

    const status = service.getPluginHealthStatus().find((item) => item.name === "fallback");
    expect(status?.isHealthy).toBe(true);
    expect(status?.failureCount).toBe(0);
    expect(status?.successCount).toBe(1);
  });

  it("aborts the plugin signal and records a timeout failure", async () => {
    const plugin = new TimeoutPlugin({
      id: "timeout",
      name: "timeout",
      priority: 1,
      timeoutMs: 15,
    });
    const service = createService(plugin);

    const result = await service.searchWithWarnings(
      "test",
      [],
      1,
      false,
      "links",
      "plugin",
      ["timeout"],
      undefined,
      {}
    );

    expect(result.response.total).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.source).toBe("timeout");
    expect(plugin.observedSignal?.aborted).toBe(true);
    expect(plugin.abortReason).toBeInstanceOf(Error);
    expect((plugin.abortReason as Error).name).toBe("TimeoutError");

    const status = service.getPluginHealthStatus().find((item) => item.name === "timeout");
    expect(status?.failureCount).toBe(1);
    expect(status?.successCount).toBe(0);
  });

  it("records plugin and registry provenance in all response shapes", async () => {
    const service = createService(
      new SuccessPlugin({
        id: "success",
        name: "success",
        priority: 1,
        version: "2.3.4",
      })
    );

    const result = await service.searchWithWarnings(
      "test",
      [],
      1,
      false,
      "all",
      "plugin",
      ["success"],
      undefined,
      {}
    );

    expect(result.response.meta).toMatchObject({
      registryVersion: 1,
      pluginVersions: { success: "2.3.4" },
    });
    expect(result.response.results?.[0]).toMatchObject({
      source: "plugin",
      pluginId: "success",
      pluginVersion: "2.3.4",
      registryVersion: 1,
    });
    expect(result.response.items?.[0]).toMatchObject({
      type: "quark",
      source: "plugin:success@2.3.4",
      pluginId: "success",
      pluginVersion: "2.3.4",
      registryVersion: 1,
    });
  });

  it("does not churn the Registry version when dynamic definitions are unchanged", async () => {
    const manager = new PluginManager();
    const plugin = new SuccessPlugin({
      id: "dynamic",
      name: "dynamic",
      priority: 1,
      version: "1.0.0",
      kind: "instructions",
    });
    let loads = 0;
    const service = new SearchService(
      {
        priorityChannels: [],
        defaultChannels: [],
        defaultConcurrency: 2,
        pluginTimeoutMs: 100,
        cacheEnabled: false,
        cacheTtlMinutes: 1,
        dynamicPluginLoader: async () => {
          loads++;
          return [plugin];
        },
      },
      manager
    );

    const [first, concurrent] = await Promise.all([
      service.searchWithWarnings(
        "first",
        [],
        1,
        false,
        "results",
        "plugin",
        undefined,
        undefined,
        {}
      ),
      service.searchWithWarnings(
        "second",
        [],
        1,
        false,
        "results",
        "plugin",
        undefined,
        undefined,
        {}
      ),
    ]);
    const version = first.response.meta?.registryVersion;
    expect(version).toBe(1);
    expect(concurrent.response.meta?.registryVersion).toBe(version);

    const again = await service.searchWithWarnings(
      "third",
      [],
      1,
      false,
      "results",
      "plugin",
      undefined,
      undefined,
      {}
    );
    expect(again.response.meta?.registryVersion).toBe(version);
    expect(manager.version).toBe(version);
    expect(loads).toBe(2);
  });

  it("merges variant query results when exact plugin results are sparse", async () => {
    const service = createService(new VariantMergePlugin({ id: "variant", name: "variant", priority: 1 }));

    const result = await service.searchWithWarnings(
      "肖申克的救赎",
      [],
      1,
      false,
      "links",
      "plugin",
      ["variant"],
      undefined,
      {}
    );

    expect(result.response.total).toBe(2);
    expect(result.warnings).toEqual([]);
  });
});
