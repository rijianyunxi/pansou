import { describe, expect, it } from "vitest";
import { SearchService, type SearchServiceOptions } from "../../server/core/services/searchService";
import { PluginManager } from "../../server/core/plugins/manager";
import type {
  PluginSearchContext,
  SearchPlugin,
} from "../../server/core/plugins/manager";
import type { SearchResult } from "../../server/core/types/models";

type Behavior = "ok" | "fail" | "empty";

function makePlugin(
  id: string,
  group: string | undefined,
  weight: number | undefined,
  behavior: Behavior
): SearchPlugin & { calls: number } {
  const plugin = {
    calls: 0,
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      kind: "code" as const,
      priority: 50,
      timeoutMs: 5000,
      maxResults: 20,
      schemaVersion: 1,
      outputTypes: [] as string[],
      upstreamGroup: group,
      upstreamWeight: weight,
    },
    async search(_context: PluginSearchContext): Promise<SearchResult[]> {
      plugin.calls++;
      if (behavior === "fail") throw new Error("upstream down");
      if (behavior === "empty") return [];
      // Enough results to stop the keyword-variant loop after one call.
      return Array.from({ length: 6 }, (_, index) => ({
        title: `${id} result ${index}`,
        unique_id: `${id}-${index}`,
        channel: id,
        links: [{ url: `https://pan.quark.cn/s/${id}-${index}` }],
      })) as unknown as SearchResult[];
    },
  };
  return plugin as unknown as SearchPlugin & { calls: number };
}

const baseOptions: SearchServiceOptions = {
  priorityChannels: [],
  defaultChannels: [],
  defaultConcurrency: 4,
  pluginTimeoutMs: 5000,
  cacheEnabled: false,
  cacheTtlMinutes: 1,
};

function buildService(plugins: SearchPlugin[]): SearchService {
  const pm = new PluginManager();
  for (const plugin of plugins) pm.register(plugin);
  return new SearchService(baseOptions, pm);
}

async function runSearch(service: SearchService, ids: string[]) {
  const { response } = await service.searchWithWarnings(
    "kw",
    [],
    4,
    true,
    "results",
    "plugin",
    ids,
    undefined,
    {}
  );
  return response;
}

describe("equivalent upstream groups", () => {
  it("runs one group member per search and rotates across searches", async () => {
    const a = makePlugin("mirror-a", "mirror", 1, "ok");
    const b = makePlugin("mirror-b", "mirror", 1, "ok");
    const service = buildService([a, b]);

    for (let index = 0; index < 4; index++) {
      const response = await runSearch(service, ["mirror-a", "mirror-b"]);
      const runners = new Set(response.results?.map((r) => r.pluginId));
      expect(runners.size).toBe(1);
    }
    expect(a.calls + b.calls).toBe(4);
    expect(a.calls).toBeGreaterThan(0);
    expect(b.calls).toBeGreaterThan(0);
  });

  it("distributes primary selection by weight", async () => {
    const heavy = makePlugin("heavy", "weighted", 3, "ok");
    const light = makePlugin("light", "weighted", 1, "ok");
    const service = buildService([heavy, light]);

    for (let index = 0; index < 8; index++) {
      await runSearch(service, ["heavy", "light"]);
    }
    // Cycle [heavy, heavy, heavy, light]: heavy leads 6 of 8 searches.
    expect(heavy.calls).toBe(6);
    expect(light.calls).toBe(2);
  });

  it("fails over to the next member when the selected upstream fails", async () => {
    const broken = makePlugin("fail-a", "failover", 10, "fail");
    const healthy = makePlugin("ok-b", "failover", 10, "ok");
    const service = buildService([broken, healthy]);

    const response = await runSearch(service, ["fail-a", "ok-b"]);
    expect(broken.calls).toBe(1);
    expect(healthy.calls).toBe(1);
    expect(response.results?.length).toBeGreaterThan(0);
    expect(response.results?.every((r) => r.pluginId === "ok-b")).toBe(true);
  });

  it("does not fail over on a legitimate zero-result answer", async () => {
    const empty = makePlugin("empty-a", "zero", 10, "empty");
    const healthy = makePlugin("ok-b", "zero", 10, "ok");
    const service = buildService([empty, healthy]);

    const response = await runSearch(service, ["empty-a", "ok-b"]);
    expect(empty.calls).toBe(1);
    expect(healthy.calls).toBe(0);
    expect(response.results?.length ?? 0).toBe(0);
  });
});
