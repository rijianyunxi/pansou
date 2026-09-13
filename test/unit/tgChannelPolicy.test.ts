import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ofetch } from "ofetch";
import {
  parseChannelPolicies,
  TG_POLICY_RANGES,
  telegramSettingsView,
  type TgChannelPolicyMap,
} from "../../server/utils/telegramSettings";
import {
  getTgChannelPolicies,
  getTgChannelPoliciesVersion,
  getTgChannelSettingsVersion,
  getTgChannelPolicy,
  saveTgChannelPolicies,
  setUpstreamParser,
} from "../../server/core/services/tgChannelSettings";
import { fetchTgChannelPosts } from "../../server/core/services/tg";

// 存储层使用与 searchSettingsPersistence.test.ts 相同的方式 mock fs：单测完全不落盘。
const fs = vi.hoisted(() => ({ existsSync: vi.fn(), mkdirSync: vi.fn(), readFileSync: vi.fn(), writeFileSync: vi.fn(), renameSync: vi.fn(), unlinkSync: vi.fn() }));
vi.mock("fs", () => fs);
vi.mock("ofetch", () => ({ ofetch: vi.fn() }));
const fetcher = vi.mocked(ofetch);

const demoPage = (options: { before?: string; extraMessage?: boolean } = {}) =>
  `<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="policydemo/1">
    <time datetime="2026-08-01T00:00:00Z"></time>
    <div class="tgme_widget_message_text">test movie 一 https://pan.quark.cn/s/one</div>
  </div></div>
  ${options.extraMessage ? `<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="policydemo/2">
    <time datetime="2026-08-02T00:00:00Z"></time>
    <div class="tgme_widget_message_text">test movie 二 https://pan.quark.cn/s/two</div>
  </div></div>` : ""}
  ${options.before ? `<a href="?before=${options.before}">older</a>` : ""}`;

beforeEach(() => {
  Object.values(fs).forEach((fn) => fn.mockReset());
  fs.existsSync.mockReturnValue(false);
  saveTgChannelPolicies(null);
  fetcher.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("parseChannelPolicies（每频道策略校验）", () => {
  it("null 表示清空；键名做 @ 前缀与大小写归一", () => {
    expect(parseChannelPolicies(null)).toBeNull();
    expect(parseChannelPolicies({ "@PolicyDemo": { timeoutMs: 5000, fallback: "direct" } })).toEqual({
      policydemo: { timeoutMs: 5000, fallback: "direct" },
    });
  });

  it("丢弃没有任何有效字段的空策略", () => {
    expect(parseChannelPolicies({ policydemo: {} })).toEqual({});
  });

  it.each([
    ["非对象入参", "nope"],
    ["非法频道键", { "bad name!": { maxPages: 2 } }],
    ["策略不是对象", { policydemo: 5 }],
    ["超时低于下限", { policydemo: { timeoutMs: TG_POLICY_RANGES.timeoutMs.min - 1 } }],
    ["超时高于上限", { policydemo: { timeoutMs: TG_POLICY_RANGES.timeoutMs.max + 1 } }],
    ["页数越界", { policydemo: { maxPages: 0 } }],
    ["结果数越界", { policydemo: { maxResults: 201 } }],
    ["数字必须是整数", { policydemo: { maxPages: 1.5 } }],
    ["fallback 枚举", { policydemo: { fallback: "auto" } }],
    ["超过频道数上限", Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`chann${i}x`, {}]))],
  ])("拒绝：%s", (_name, value) => {
    expect(() => parseChannelPolicies(value)).toThrow();
  });

  it("telegramSettingsView 始终带 policies 字段（additive）", () => {
    expect(telegramSettingsView(["policydemo"], []).policies).toEqual({});
    const map: TgChannelPolicyMap = { policydemo: { maxPages: 3 } };
    expect(telegramSettingsView(["policydemo"], [], map).policies).toEqual(map);
    // 旧字段保持不变
    expect(telegramSettingsView(null, ["@SysChan"]).effectiveChannels).toEqual(["syschan"]);
  });
});

describe("tgChannelSettings 存储（沿用 settings 持久化模式）", () => {
  it("保存后可按频道读取（大小写/前缀不敏感），返回克隆", () => {
    const saved = saveTgChannelPolicies({ policydemo: { timeoutMs: 8000 } });
    expect(saved).toEqual({ policydemo: { timeoutMs: 8000 } });
    expect(getTgChannelPolicy("@PolicyDemo")).toEqual({ timeoutMs: 8000 });
    expect(getTgChannelPolicy("unknown")).toBeUndefined();
    saved.policydemo!.timeoutMs = 1;
    expect(getTgChannelPolicy("policydemo")!.timeoutMs).toBe(8000);
  });

  it("每次保存递增版本号，写入失败时保持内存与版本不变", async () => {
    const before = getTgChannelPoliciesVersion();
    saveTgChannelPolicies({ policydemo: { maxPages: 2 } });
    expect(getTgChannelPoliciesVersion()).toBeGreaterThan(before);
    const db = (await import("../../server/core/storage/sqlite")).getSqliteDatabase();
    const originalTransaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementationOnce(() => { throw new Error("read only"); });
    expect(() => saveTgChannelPolicies({ policydemo: { maxPages: 3 } })).toThrow("read only");
    vi.spyOn(db, "transaction").mockImplementation(originalTransaction);
    expect(getTgChannelPolicy("policydemo")!.maxPages).toBe(2);
    expect(getTgChannelPolicies().policydemo!.maxPages).toBe(2);
  });

  it("配置版本包含持久化的解析器绑定", () => {
    const before = getTgChannelSettingsVersion();
    setUpstreamParser("configured-demo", "parser-v1");
    const after = getTgChannelSettingsVersion();
    expect(after).not.toBe(before);
    setUpstreamParser("configured-demo", null);
  });

  it("读取 SQLite 中的策略时宽松清洗非法条目", async () => {
    const db = (await import("../../server/core/storage/sqlite")).getSqliteDatabase();
    const now = Date.now();
    db.run("INSERT INTO tg_channel_policies(channel,timeout_ms,max_pages,updated_at) VALUES(?,?,?,?)", "gooddemo", 5000, 99, now);
    db.run("INSERT INTO tg_channel_policies(channel,timeout_ms,updated_at) VALUES(?,?,?)", "bad key", 1, now);
    db.run("INSERT INTO tg_channel_policies(channel,fallback,updated_at) VALUES(?,?,?)", "stale@", "direct", now);
    db.run("INSERT INTO tg_channel_policies(channel,timeout_ms,updated_at) VALUES(?,?,?)", "emptypol", "fast", now);
    expect(getTgChannelPolicies()).toEqual({ gooddemo: { timeoutMs: 5000 } });
    expect(getTgChannelPolicy("GOODDEMO")!.timeoutMs).toBe(5000);
  });
});

describe("每频道策略在抓取路径生效", () => {
  it("maxResults 限制单频道结果数并减少抓取", async () => {
    saveTgChannelPolicies({ policydemo: { maxResults: 1 } });
    fetcher.mockResolvedValue(demoPage({ extraMessage: true }));
    const results = await fetchTgChannelPosts("policydemo", "test", { limitPerChannel: 50 });
    expect(results).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("maxPages 覆盖按结果数推导的分页数", async () => {
    saveTgChannelPolicies({ policydemo: { maxPages: 1 } });
    fetcher.mockResolvedValue(demoPage({ before: "100" }));
    vi.useFakeTimers();
    const promise = fetchTgChannelPosts("policydemo", "test", { limitPerChannel: 160 });
    await vi.advanceTimersByTimeAsync(0);
    await promise;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fallback=direct 时失败后不再尝试 Jina", async () => {
    saveTgChannelPolicies({ policydemo: { fallback: "direct" } });
    fetcher.mockRejectedValue(new Error("network down"));
    await expect(fetchTgChannelPosts("policydemo", "test")).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe("https://t.me/s/policydemo?q=test");
  });

  it("fallback=jina 时直接走镜像，不请求直连", async () => {
    saveTgChannelPolicies({ policydemo: { fallback: "jina" } });
    fetcher.mockResolvedValue(demoPage());
    const results = await fetchTgChannelPosts("policydemo", "test");
    expect(results).toHaveLength(1);
    expect(fetcher.mock.calls[0]![0]).toBe("https://r.jina.ai/https://t.me/s/policydemo?q=test");
  });

  it("timeoutMs 覆盖调用方超时（策略优先）", async () => {
    saveTgChannelPolicies({ policydemo: { timeoutMs: 1500 } });
    fetcher.mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    const promise = fetchTgChannelPosts("policydemo", "test", { timeoutMs: 10_000 });
    const assertion = expect(promise).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(1500);
    await assertion;
  });
});
