import { createServer, type Server } from "node:http";
import { createApp, toNodeListener } from "h3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuthToken } from "../../server/utils/auth";
import { createPluginHealthChecker } from "../../server/core/plugins/pluginHealth";

/**
 * /api/monitor 聚合端点：mock 掉服务定位器、插件仓库、搜索设置与频道存储，
 * 验证响应信封与逐字段形状（前端 monitorView 依赖的契约）。
 */
const mocks = vi.hoisted(() => ({
  plugins: [
    {
      manifest: {
        id: "hunhepan", name: "混合盘", version: "1.0.0", kind: "code",
        priority: 10, timeoutMs: 5000, maxResults: 100, schemaVersion: 1, outputTypes: [],
      },
    },
    {
      manifest: {
        id: "nyaacode", name: "Nyaacode", version: "0.9.0", kind: "code",
        priority: 5, timeoutMs: 5000, maxResults: 100, schemaVersion: 1, outputTypes: [],
      },
    },
    {
      manifest: {
        id: "ruleplugin", name: "规则插件", version: "2.0.0", kind: "instructions",
        priority: 8, timeoutMs: 5000, maxResults: 100, schemaVersion: 1, outputTypes: [],
      },
    },
  ],
  records: [
    {
      id: "ruleplugin",
      status: "published",
      publishedVersion: "2.0.0",
      definition: { manifest: { id: "ruleplugin", name: "规则插件", version: "2.1.0-draft", kind: "instructions" } },
    },
    {
      id: "disabledplugin",
      status: "disabled",
      publishedVersion: "1.0.0",
      definition: { manifest: { id: "disabledplugin", name: "停用插件", version: "1.1.0", kind: "instructions" } },
    },
    {
      id: "archivedplugin",
      status: "archived",
      publishedVersion: "1.5.0",
      definition: { manifest: { id: "archivedplugin", name: "归档插件", version: "1.6.0", kind: "instructions" } },
    },
  ],
  settings: {
    channels: ["customone"],
    trashedPlugins: ["nyaacode"],
    plugins: null,
    concurrency: null,
    pluginTimeoutMs: null,
  },
  states: {
    customone: { enabled: false, deleted: false },
    gonechan: { enabled: true, deleted: true },
  } as Record<string, unknown>,
  policies: { builtinone: { maxPages: 2, fallback: "direct" } } as Record<string, unknown>,
  channelHealth: {
    // 健康记录本身不是频道配置来源，历史孤儿记录不应出现在监控清单。
    historicalonly: {
      channel: "historicalonly",
      lastCheckedAt: 1_760_000_000_000,
      lastState: "error",
      successRate: 0,
      lastMessage: "历史记录",
      failureKind: "network_error",
      elapsedMs: 320,
      resultsCount: 0,
      recent: [],
    },
    builtinone: {
      channel: "builtinone",
      lastCheckedAt: 1_760_000_000_000,
      lastState: "warning",
      successRate: 0.5,
      lastMessage: "频道可访问，但当前关键词没有提取到网盘链接",
      failureKind: "no_results",
      elapsedMs: 320,
      resultsCount: 0,
      recent: [
        { at: 1_760_000_000_000, ok: true, elapsedMs: 320, resultsCount: 0, source: "probe" },
        { at: 1_760_000_100_000, ok: false, elapsedMs: 900, resultsCount: 0, failureKind: "network_error", source: "search" },
      ],
    },
  } as Record<string, unknown>,
}));

vi.mock("../../server/core/services", () => ({
  getOrCreateSearchService: () => ({
    getPluginManager: () => ({
      snapshot: () => ({
        version: 7,
        plugins: mocks.plugins.filter((plugin) => plugin.manifest.id !== "nyaacode"),
      }),
      list: ({ includeDisabled }: { includeDisabled?: boolean }) =>
        includeDisabled ? mocks.plugins : mocks.plugins.filter((plugin) => plugin.manifest.id !== "nyaacode"),
    }),
    getPluginHealthStatus: () => checker.getAllStatus(),
  }),
}));
vi.mock("../../server/core/plugins/repository", () => ({
  getPluginRepository: () => ({
    list: async () => mocks.records,
  }),
}));
vi.mock("../../server/core/services/searchSettingsService", () => ({
  getSearchSettings: () => mocks.settings,
}));
vi.mock("../../server/core/services/tgChannelSettings", () => ({
  getTgChannelPolicies: () => mocks.policies,
  getTgChannelStates: () => mocks.states,
}));
vi.mock("../../server/core/services/tgChannelHealthStore", () => ({
  getAllTgChannelHealthSummaries: () => mocks.channelHealth,
}));

import monitorRoute from "../../server/api/monitor.get";

const checker = createPluginHealthChecker();
checker.recordSuccess("hunhepan", 120, { resultCount: 3 });
checker.recordFailure("hunhepan", {
  responseTimeMs: 300,
  errorCategory: "timeout_error",
  errorMessage: "upstream timed out",
});

let server: Server;
let base: string;
const adminCookie = `panhub_admin=${createAuthToken("secret")}`;

beforeAll(async () => {
  vi.stubGlobal("useRuntimeConfig", () => ({
    adminPassword: "secret",
    defaultChannels: ["BuiltinOne"],
  }));
  const app = createApp();
  app.use("/api/monitor", monitorRoute);
  server = createServer(toNodeListener(app));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllGlobals();
});

async function getMonitor(headers: Record<string, string> = {}) {
  const response = await fetch(`${base}/api/monitor`, { headers });
  return { response, body: await response.json() };
}

describe("GET /api/monitor", () => {
  it("未携带管理员凭据时返回 401", async () => {
    const { response } = await getMonitor();
    expect(response.status).toBe(401);
  });

  it("聚合上游与频道并输出契约形状", async () => {
    const { response, body } = await getMonitor({ cookie: adminCookie });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body.code).toBe(0);
    expect(typeof body.data.generatedAt).toBe("string");
    expect(Number.isFinite(Date.parse(body.data.generatedAt))).toBe(true);

    const upstreams = body.data.upstreams;
    const byId = Object.fromEntries(upstreams.map((item: any) => [item.id, item]));
    expect(Object.keys(byId).sort()).toEqual([
      "archivedplugin", "disabledplugin", "hunhepan", "nyaacode", "ruleplugin",
    ]);

    // 逐字段形状（upstream）
    for (const entry of upstreams) {
      expect(Object.keys(entry).sort()).toEqual(["enabled", "health", "id", "kind", "name", "trashed", "version"]);
      expect(["code", "instructions"]).toContain(entry.kind);
    }
    expect(byId.hunhepan).toMatchObject({
      name: "混合盘", kind: "code", enabled: true, trashed: false, version: "1.0.0",
    });
    const health = byId.hunhepan.health;
    expect(Object.keys(health).sort()).toEqual([
      "circuitState", "dimensions", "failureCount", "healthy", "history",
      "lastErrorMessage", "lastFailureAt", "lastSuccessAt", "requestCount",
      "successCount", "zeroResultCount",
    ]);
    expect(health.healthy).toBe(true);
    expect(health.circuitState).toBe("closed");
    expect(health.requestCount).toBe(2);
    expect(health.successCount).toBe(1);
    expect(health.failureCount).toBe(1); // 累计失败（totalFailureCount）
    expect(health.zeroResultCount).toBe(0);
    expect(typeof health.lastSuccessAt).toBe("number");
    expect(typeof health.lastFailureAt).toBe("number");
    expect(health.lastErrorMessage).toBe("upstream timed out");
    expect(Object.keys(health.dimensions).sort()).toEqual(["business", "http", "network", "parsing", "results"]);
    expect(health.dimensions.network).toMatchObject({ state: "fail", lastMessage: "upstream timed out" });
    expect(typeof health.dimensions.network.recent).toBe("string");
    expect(health.history).toMatchObject({ windowHours: 24 });
    expect(health.history.buckets[0]).toMatchObject({ n: 2, s: 1, f: 1 });
    expect(health.history.buckets[0].e).toEqual({ timeout_error: 1 });

    // 垃圾箱 / 停用 / 仓库记录推导
    expect(byId.nyaacode).toMatchObject({ enabled: false, trashed: true, version: "0.9.0" });
    expect(byId.disabledplugin).toMatchObject({ enabled: false, trashed: false, version: "1.0.0", health: null });
    expect(byId.archivedplugin).toMatchObject({ enabled: false, trashed: true, version: "1.5.0" });
    expect(byId.ruleplugin).toMatchObject({
      kind: "instructions", enabled: true, trashed: false, version: "2.0.0", name: "规则插件",
    });

    // 逐字段形状（channel）
    const channels = body.data.channels;
    const byChannel = Object.fromEntries(channels.map((item: any) => [item.channel, item]));
    expect(Object.keys(byChannel).sort()).toEqual(["builtinone", "customone", "gonechan"]);
    for (const entry of channels) {
      expect(Object.keys(entry).sort()).toEqual(["channel", "deleted", "enabled", "health", "origin", "policy"]);
      expect(["builtin", "custom"]).toContain(entry.origin);
    }
    expect(byChannel.builtinone).toMatchObject({
      origin: "builtin", enabled: true, deleted: false,
      policy: { maxPages: 2, fallback: "direct" },
    });
    const channelHealth = byChannel.builtinone.health;
    expect(Object.keys(channelHealth).sort()).toEqual([
      "elapsedMs", "failureKind", "lastCheckedAt", "message", "recent", "resultsCount", "state", "successRate",
    ]);
    expect(channelHealth.state).toBe("warning");
    expect(channelHealth.failureKind).toBe("no_results");
    expect(channelHealth.lastCheckedAt).toBe(1_760_000_000_000);
    expect(channelHealth.message).toContain("没有提取到网盘链接");
    expect(channelHealth.successRate).toBe(0.5);
    expect(channelHealth.recent).toHaveLength(2);
    expect(Object.keys(channelHealth.recent[0]).sort()).toEqual(["at", "elapsedMs", "ok", "resultsCount", "source"]);
    expect(Object.keys(channelHealth.recent[1]).sort()).toEqual([
      "at", "elapsedMs", "failureKind", "ok", "resultsCount", "source",
    ]);

    expect(byChannel.customone).toMatchObject({
      origin: "custom", enabled: false, deleted: false, policy: null, health: null,
    });
    expect(byChannel.gonechan).toMatchObject({ origin: "custom", enabled: true, deleted: true });
  });

  it("聚合失败时返回非 0 code 与 message", async () => {
    const previous = mocks.records;
    (mocks as any).records = null;
    const { response, body } = await getMonitor({ cookie: adminCookie });
    expect(response.status).toBe(200);
    expect(body.code).not.toBe(0);
    expect(typeof body.message).toBe("string");
    (mocks as any).records = previous;
  });
});
