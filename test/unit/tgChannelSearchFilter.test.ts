import { beforeEach, describe, expect, it, vi } from "vitest";
import { SearchService } from "../../server/core/services/searchService";
import { PluginManager } from "../../server/core/plugins/manager";
import {
  clearTgChannelState,
  getTgChannelPoliciesVersion,
  setTgChannelState,
} from "../../server/core/services/tgChannelSettings";
import { getTgChannelHealthSummary } from "../../server/core/services/tgChannelHealthStore";

// 存储层 mock fs（不落盘）；TG 抓取模块整体 mock（单测严禁公网）。
const fs = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}));
vi.mock("fs", () => fs);

const fetchTgChannelPosts = vi.hoisted(() => vi.fn());
vi.mock("../../server/core/services/tg", () => ({ fetchTgChannelPosts }));

const tgResult = (channel: string) => ({
  message_id: "1",
  unique_id: `tg-${channel}-1`,
  channel,
  datetime: "",
  title: `t-${channel}`,
  content: "c",
  links: [],
});

const createService = () =>
  new SearchService(
    {
      priorityChannels: [],
      defaultChannels: [],
      defaultConcurrency: 2,
      pluginTimeoutMs: 5000,
      cacheEnabled: false,
      cacheTtlMinutes: 1,
    },
    new PluginManager(),
  );

beforeEach(() => {
  Object.values(fs).forEach((fn) => fn.mockReset());
  fs.existsSync.mockReturnValue(false);
  fetchTgChannelPosts.mockReset();
  // 健康存储没有清理接口，各用例使用互不相同的频道名保证隔离。
});

describe("searchTG：频道生效清单过滤 + 频道健康记录", () => {
  it("停用与已删除的频道不参与抓取，健康只记录实际抓取的频道", async () => {
    setTgChannelState("offchan", { enabled: false });
    setTgChannelState("gonechan", { deleted: true });
    fetchTgChannelPosts.mockImplementation(async (channel: string) => {
      if (channel === "badchan") {
        throw Object.assign(new Error("TG 频道 badchan 请求失败"), { tgKind: "network_error" });
      }
      return [tgResult(channel)];
    });

    const service = createService();
    // 关键词长度 1：不触发深搜，每频道恰好抓取一次。
    const results = await (service as any).searchTG(
      "k",
      ["goodchan", "@offchan", "gonechan", "badchan", "bad name"],
      false,
      undefined,
      {},
    );

    expect(results.map((item: any) => item.channel)).toEqual(["goodchan"]);
    expect([...fetchTgChannelPosts.mock.calls.map((call: any[]) => call[0])].sort()).toEqual([
      "badchan",
      "goodchan",
    ]);

    const good = getTgChannelHealthSummary("goodchan")!;
    expect(good).toMatchObject({ lastState: "available", resultsCount: 1, successRate: 1 });
    expect(good.recent[0]).toMatchObject({ ok: true, source: "search" });
    // 被过滤的频道没有任何抓取与健康记录
    expect(getTgChannelHealthSummary("offchan")).toBeNull();
    expect(getTgChannelHealthSummary("gonechan")).toBeNull();
    // 失败频道带分类记录
    expect(getTgChannelHealthSummary("badchan")).toMatchObject({
      lastState: "error",
      failureKind: "network_error",
      successRate: 0,
    });
  });

  it("搜索零结果记为成功（available），缓存键随覆盖状态版本变化", async () => {
    fetchTgChannelPosts.mockResolvedValue([]);
    const service = createService();
    await (service as any).searchTG("k", ["emptychan"], false, undefined, {});
    expect(getTgChannelHealthSummary("emptychan")).toMatchObject({
      lastState: "available",
      resultsCount: 0,
    });

    const before = getTgChannelPoliciesVersion();
    setTgChannelState("emptychan", { enabled: false });
    expect(getTgChannelPoliciesVersion()).toBeGreaterThan(before);
    clearTgChannelState("emptychan");
  });

  it("调用方取消（AbortSignal）不记为频道失败", async () => {
    const controller = new AbortController();
    fetchTgChannelPosts.mockImplementationOnce(async () => {
      controller.abort();
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    });
    const service = createService();
    const execution = {
      signal: controller.signal,
      schedule: (task: () => unknown) => task(),
    };
    const results = await (service as any).searchTG(
      "kw",
      ["cancelchan"],
      false,
      undefined,
      {},
      undefined,
      execution,
    );
    expect(results).toEqual([]);
    expect(getTgChannelHealthSummary("cancelchan")).toBeNull();
  });
});
