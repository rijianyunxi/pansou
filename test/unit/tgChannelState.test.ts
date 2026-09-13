import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeTgChannelParam,
  sanitizeChannelStates,
  tgChannelOrigin,
} from "../../server/utils/telegramSettings";

// 存储层与 tgChannelPolicy.test.ts 相同的方式 mock fs：单测完全不落盘。
const fs = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}));
vi.mock("fs", () => fs);

type StoreModule = typeof import("../../server/core/services/tgChannelSettings");

/** 每个用例独立的 store 模块实例（模块级缓存互不干扰）。 */
async function freshStore(): Promise<StoreModule> {
  vi.resetModules();
  return await import("../../server/core/services/tgChannelSettings");
}

beforeEach(() => {
  Object.values(fs).forEach((fn) => fn.mockReset());
  fs.existsSync.mockReturnValue(false);
});

describe("sanitizeChannelStates（覆盖状态宽松清洗）", () => {
  it("非法键/非法条目直接丢弃，键名做 @ 与大小写归一", () => {
    expect(sanitizeChannelStates({
      "@OffChan": { enabled: false, deleted: false },
      "bad key!": { enabled: false },
      brokenchan: "nope",
      abcd: { enabled: false },
    })).toEqual({ offchan: { enabled: false, deleted: false } });
  });

  it("布尔值缺省回退默认（enabled=true / deleted=false），无覆盖信息的条目被丢弃", () => {
    expect(sanitizeChannelStates({
      keepdisabled: { enabled: false },
      keepdeleted: { deleted: true, enabled: true },
      noopchan: { enabled: true, deleted: false },
      noopempty: {},
      partialchan: { enabled: "false" },
    })).toEqual({
      keepdisabled: { enabled: false, deleted: false },
      keepdeleted: { enabled: true, deleted: true },
    });
  });

  it("非对象入参返回空表", () => {
    expect(sanitizeChannelStates(null)).toEqual({});
    expect(sanitizeChannelStates("nope")).toEqual({});
    expect(sanitizeChannelStates([{ enabled: false }])).toEqual({});
  });
});

describe("normalizeTgChannelParam / tgChannelOrigin", () => {
  it("频道参数归一：去空白、去 @、小写", () => {
    expect(normalizeTgChannelParam(" @MixedCase_Channel ")).toBe("mixedcase_channel");
    expect(normalizeTgChannelParam(undefined)).toBe("");
  });

  it("origin：自定义清单优先，其次内置默认，其余按 custom 兜底", () => {
    expect(tgChannelOrigin("CustomOne", ["customone"], ["builtinone"])).toBe("custom");
    expect(tgChannelOrigin("@BuiltinOne", ["customone"], ["BuiltinOne"])).toBe("builtin");
    expect(tgChannelOrigin("builtinone", null, ["builtinone"])).toBe("builtin");
    expect(tgChannelOrigin("extraone", null, ["builtinone"])).toBe("custom");
  });
});

describe("tgChannelSettings 频道覆盖状态存储", () => {
  it("默认没有任何覆盖状态", async () => {
    const store = await freshStore();
    expect(store.getTgChannelStates()).toEqual({});
    expect(store.getTgChannelState("offchan")).toBeUndefined();
  });

  it("disable：写入覆盖状态、持久化为 v2 格式、版本号递增", async () => {
    const store = await freshStore();
    const before = store.getTgChannelPoliciesVersion();
    const entry = store.setTgChannelState("@OffChan", { enabled: false });
    expect(entry).toEqual({ enabled: false, deleted: false });
    expect(store.getTgChannelState("OFFCHAN")).toEqual({ enabled: false, deleted: false });
    expect(store.getTgChannelPoliciesVersion()).toBeGreaterThan(before);

    const db = (await import("../../server/core/storage/sqlite")).getSqliteDatabase();
    const written = db.get<any>("tg_channel_settings", "state", {});
    expect(written.channelState).toEqual({ offchan: { enabled: false, deleted: false } });
    expect(written.policies).toEqual({});
  });

  it("delete 覆盖：内置默认频道置 deleted=true，可保留 enabled 状态", async () => {
    const store = await freshStore();
    const entry = store.setTgChannelState("gonechan", { deleted: true });
    expect(entry).toEqual({ enabled: true, deleted: true });
    expect(store.getTgChannelState("gonechan")?.deleted).toBe(true);

    const both = store.setTgChannelState("gonechan", { enabled: false });
    expect(both).toEqual({ enabled: false, deleted: true });
  });

  it("enable：清除全部覆盖（启用 = 恢复），无覆盖的条目从存储中移除", async () => {
    const store = await freshStore();
    store.setTgChannelState("gonechan", { enabled: false, deleted: true });
    store.clearTgChannelState("gonechan");
    expect(store.getTgChannelState("gonechan")).toBeUndefined();
    expect(store.getTgChannelStates()).toEqual({});

    // 幂等：清除不存在的频道不抛错、不递增版本
    const before = store.getTgChannelPoliciesVersion();
    store.clearTgChannelState("ghostchan");
    expect(store.getTgChannelPoliciesVersion()).toBe(before);
  });

  it("恢复为无覆盖时条目被清理（存储最小化）", async () => {
    const store = await freshStore();
    store.setTgChannelState("offchan", { enabled: false });
    store.setTgChannelState("offchan", { enabled: true });
    expect(store.getTgChannelStates()).toEqual({});
  });

  it("非法频道名直接抛错且不落盘", async () => {
    const store = await freshStore();
    expect(() => store.setTgChannelState("bad name!", { enabled: false })).toThrow();
    expect(store.getTgChannelStates()).toEqual({});
  });

  it("写入失败时内存与版本号保持不变（失败不假成功）", async () => {
    const store = await freshStore();
    store.setTgChannelState("offchan", { enabled: false });
    const version = store.getTgChannelPoliciesVersion();
    const db = (await import("../../server/core/storage/sqlite")).getSqliteDatabase();
    const originalTransaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementationOnce(() => { throw new Error("read only"); });
    expect(() => store.setTgChannelState("offchan", { enabled: true })).toThrow("read only");
    vi.spyOn(db, "transaction").mockImplementation(originalTransaction);
    expect(store.getTgChannelState("offchan")).toEqual({ enabled: false, deleted: false });
    expect(store.getTgChannelPoliciesVersion()).toBe(version);
  });

  it("saveTgChannelPolicies 只替换策略，保留覆盖状态；两者共享版本号", async () => {
    const store = await freshStore();
    store.setTgChannelState("offchan", { enabled: false });
    const version = store.getTgChannelPoliciesVersion();
    const saved = store.saveTgChannelPolicies({ policydemo: { maxPages: 2 } });
    expect(saved).toEqual({ policydemo: { maxPages: 2 } });
    expect(store.getTgChannelState("offchan")).toEqual({ enabled: false, deleted: false });
    expect(store.getTgChannelPoliciesVersion()).toBeGreaterThan(version);

    const db = (await import("../../server/core/storage/sqlite")).getSqliteDatabase();
    const written = db.get<any>("tg_channel_settings", "state", {});
    expect(written.channelState).toEqual({ offchan: { enabled: false, deleted: false } });
  });

  it("读取 SQLite 中的策略与覆盖状态并清洗非法条目", async () => {
    const store = await freshStore();
    const db = (await import("../../server/core/storage/sqlite")).getSqliteDatabase();
    db.set("tg_channel_settings", "state", {
      policies: { gooddemo: { timeoutMs: 5000 }, "bad key": { timeoutMs: 1 } },
      channelState: {
        offchan: { enabled: false, deleted: false },
        gonechan: { enabled: true, deleted: true },
        "bad key": { enabled: false },
        noopchan: { enabled: true, deleted: false },
        brokenchan: "nope",
      },
    });
    expect(store.getTgChannelPolicies()).toEqual({ gooddemo: { timeoutMs: 5000 } });
    expect(store.getTgChannelStates()).toEqual({
      offchan: { enabled: false, deleted: false },
      gonechan: { enabled: true, deleted: true },
    });
  });
});

describe("频道生效清单过滤", () => {
  it("enabled=false 与 deleted=true 的频道从生效清单剔除，入参同时归一", async () => {
    const store = await freshStore();
    store.setTgChannelState("offchan", { enabled: false });
    store.setTgChannelState("gonechan", { deleted: true });
    expect(store.filterEffectiveTgChannels([
      "GoodChan",
      "@offchan",
      "GONECHAN",
      "not4chan",
      "bad name",
    ])).toEqual(["goodchan", "not4chan"]);
  });

  it("无覆盖状态时原样（归一后）返回", async () => {
    const store = await freshStore();
    expect(store.filterEffectiveTgChannels(["@Alpha", "betach"])).toEqual(["alpha", "betach"]);
    expect(store.filterEffectiveTgChannels([])).toEqual([]);
    expect(store.filterEffectiveTgChannels(undefined as unknown as string[])).toEqual([]);
  });

  it("countEffectiveTgChannels 给出当前生效频道数", async () => {
    const store = await freshStore();
    store.setTgChannelState("gonechan", { deleted: true });
    expect(store.countEffectiveTgChannels(["alpha", "betach", "gonechan", "@alpha"])).toBe(2);
  });
});
