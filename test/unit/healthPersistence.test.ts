import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPluginHealthChecker } from "../../server/core/plugins/pluginHealth";
import { SqlitePluginHealthStore } from "../../server/core/plugins/healthStore";
import { SearchService, type SearchServiceOptions } from "../../server/core/services/searchService";
import { PluginManager } from "../../server/core/plugins/manager";
import type { PluginSearchContext, SearchPlugin } from "../../server/core/plugins/manager";
import type { SearchResult } from "../../server/core/types/models";

describe("plugin health persistence", () => {
  it("exports and restores counters and circuit state", () => {
    const checker = createPluginHealthChecker();
    for (let index = 0; index < 6; index++) {
      checker.recordFailure("broken", { errorCategory: "http_error" });
    }
    checker.recordSuccess("healthy", 120, { resultCount: 3 });
    const snapshot = checker.exportSnapshot();
    expect(snapshot.broken?.circuitState).toBe("open");
    expect(snapshot.healthy?.successCount).toBe(1);

    const revived = createPluginHealthChecker();
    revived.importSnapshot(JSON.parse(JSON.stringify(snapshot)));
    expect(revived.getStatus("broken")?.failureCount).toBe(6);
    expect(revived.getStatus("broken")?.circuitState).toBe("open");
    expect(revived.getStatus("healthy")?.parsingSuccessRate).toBe(1);

    // A restored open circuit recovers through the normal half-open cooldown.
    expect(revived.isHealthy("broken")).toBe(false);
    const cooled = JSON.parse(JSON.stringify(snapshot)) as Record<string, any>;
    cooled.broken.lastFailureTime = Date.now() - 10 * 60_000;
    revived.importSnapshot(cooled);
    expect(revived.canExecute("broken")).toBe(true);
  });

  it("persists failures to the store after a failing search", async () => {
    const dir = await mkdtemp(join(tmpdir(), "panhub-health-"));
    const dbPath = join(dir, "health.sqlite");
    const store = new SqlitePluginHealthStore(dbPath);
    const pm = new PluginManager();
    pm.register({
      manifest: {
        id: "broken-plugin",
        name: "broken",
        version: "1.0.0",
        kind: "code",
        priority: 50,
        timeoutMs: 5000,
        maxResults: 20,
        schemaVersion: 1,
        outputTypes: [],
      },
      async search(_context: PluginSearchContext): Promise<SearchResult[]> {
        throw new Error("upstream down");
      },
    } as unknown as SearchPlugin);
    const options: SearchServiceOptions = {
      ...({} as SearchServiceOptions),
      priorityChannels: [],
      defaultChannels: [],
      defaultConcurrency: 2,
      pluginTimeoutMs: 5000,
      cacheEnabled: false,
      cacheTtlMinutes: 1,
      healthStore: store,
    };
    const service = new SearchService(options, pm);
    await service.searchWithWarnings(
      "kw",
      [],
      2,
      true,
      "results",
      "plugin",
      ["broken-plugin"],
      undefined,
      {}
    );
    await service.flushHealthSnapshot();

    const persisted = await store.load();
    expect(persisted["broken-plugin"]?.totalFailureCount).toBeGreaterThan(0);
    expect(persisted["broken-plugin"]?.lastErrorCategory).toBeDefined();
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips dimension states and hourly history through a snapshot", () => {
    const checker = createPluginHealthChecker();
    checker.recordSuccess("mixed", 50, { resultCount: 4 });
    checker.recordFailure("mixed", {
      errorCategory: "timeout_error",
      errorMessage: "request timed out",
    });
    const snapshot = JSON.parse(JSON.stringify(checker.exportSnapshot()));

    const revived = createPluginHealthChecker();
    revived.importSnapshot(snapshot);
    const status = revived.getStatus("mixed")!;
    const dims = status.dimensions!;
    expect(dims.network.state).toBe("fail");
    expect(dims.network.recent).toBe("10");
    expect(dims.network.passRate).toBe(0.5);
    expect(dims.network.lastMessage).toBe("request timed out");
    // 网络失败发生在 HTTP 之前的层：结果维度“本次未知”，但样本环保留历史。
    expect(dims.results.state).toBe("unknown");
    expect(dims.results.recent).toBe("1");
    expect(dims.results.passRate).toBe(1);

    const history = status.history!;
    expect(history.windowHours).toBeGreaterThan(0);
    expect(history.buckets).toHaveLength(1);
    expect(history.buckets[0]).toMatchObject({ n: 2, s: 1, f: 1, z: 0 });
    expect(history.buckets[0]!.e).toEqual({ timeout_error: 1 });
  });

  it("sanitizes hostile or corrupted snapshot payloads on import", () => {
    const revived = createPluginHealthChecker();
    const longKey = "x".repeat(300);
    revived.importSnapshot({
      [longKey]: {
        errorCounts: { parse_error: 2, bad: -5, worse: Number.NaN },
        lastErrorMessage: "e".repeat(1000),
        dimensions: {
          network: { state: "fail", recent: "1".repeat(48) + "0x" },
          bogus: { state: "nope", recent: "1" },
        },
        history: {
          windowHours: 999,
          buckets: [
            { t: "bad", n: 5 },
            { t: Date.UTC(2026, 8, 11, 3), n: 2, s: 1, f: 1, e: { timeout_error: 2 } },
          ],
        },
      },
    } as unknown as Parameters<typeof revived.importSnapshot>[0]);

    const status = revived.getStatus("x".repeat(128))!;
    expect(status.name).toHaveLength(128);
    expect(status.lastErrorMessage).toHaveLength(300);
    expect(status.errorCounts).toEqual({ parse_error: 2 });
    expect(status.dimensions!.network.recent).toHaveLength(49);
    expect(status.dimensions!.network.recent).toMatch(/^[10e]+$/);
    expect((status.dimensions as unknown as Record<string, unknown>).bogus).toBeUndefined();
    expect(status.dimensions!.http.state).toBe("unknown");
    expect(status.history!.windowHours).toBeLessThanOrEqual(24);
    expect(status.history!.buckets).toEqual([
      expect.objectContaining({ n: 2, s: 1, f: 1, e: { timeout_error: 2 } }),
    ]);
  });
});
