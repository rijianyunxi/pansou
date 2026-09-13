import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveTgChannelState,
  MAX_TG_CHANNEL_HEALTH_CHANNELS,
  MAX_TG_CHANNEL_HEALTH_RECORDS,
  type TgChannelHealthRecord,
} from "../../server/core/services/tgChannelHealthStore";

// 与 tgChannelState.test.ts 相同的 fs mock：单测完全不落盘。
const fs = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}));
vi.mock("fs", () => fs);

type StoreModule = typeof import("../../server/core/services/tgChannelHealthStore");

async function freshStore(options: { envPath?: string } = {}): Promise<StoreModule> {
  vi.resetModules();
  if (options.envPath) {
    vi.stubEnv("PANHUB_TG_CHANNEL_HEALTH", options.envPath);
  }
  return await import("../../server/core/services/tgChannelHealthStore");
}

const record = (overrides: Partial<TgChannelHealthRecord> = {}): TgChannelHealthRecord => ({
  at: 1_700_000_000_000,
  ok: true,
  elapsedMs: 100,
  resultsCount: 3,
  source: "search",
  ...overrides,
});

beforeEach(() => {
  Object.values(fs).forEach((fn) => fn.mockReset());
  fs.existsSync.mockReturnValue(false);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("deriveTgChannelState（状态推导）", () => {
  it("失败 → error；成功有结果 → available", () => {
    expect(deriveTgChannelState(record({ ok: false }))).toBe("error");
    expect(deriveTgChannelState(record({ resultsCount: 2 }))).toBe("available");
  });

  it("零结果：探针视为 warning（可访问但无链接），搜索视为 available（关键词无命中）", () => {
    expect(deriveTgChannelState(record({ resultsCount: 0, source: "probe" }))).toBe("warning");
    expect(deriveTgChannelState(record({ resultsCount: 0, source: "search" }))).toBe("available");
  });
});

describe("TG 频道健康存储", () => {
  it("record 后聚合出最近状态、成功率与最近记录", async () => {
    const store = await freshStore();
    store.recordTgChannelHealth({
      channel: "@GoodChan", ok: true, elapsedMs: 120, resultsCount: 4, source: "probe",
    });
    store.recordTgChannelHealth({
      channel: "goodchan", ok: false, elapsedMs: 300, resultsCount: 0,
      failureKind: "network_error", message: "TG 频道 goodchan 请求失败", source: "search",
    });
    const summary = store.getTgChannelHealthSummary("GOODCHAN")!;
    expect(summary.channel).toBe("goodchan");
    expect(summary.lastState).toBe("error");
    expect(summary.successRate).toBe(0.5);
    expect(summary.failureKind).toBe("network_error");
    expect(summary.lastMessage).toBe("TG 频道 goodchan 请求失败");
    expect(summary.elapsedMs).toBe(300);
    expect(summary.resultsCount).toBe(0);
    expect(summary.recent).toHaveLength(2);
    expect(summary.recent[0]).toMatchObject({ ok: true, resultsCount: 4, source: "probe" });
    expect(typeof summary.lastCheckedAt).toBe("number");
  });

  it("每频道只保留最近 20 条，成功率按窗口计算", async () => {
    const store = await freshStore();
    for (let index = 0; index < MAX_TG_CHANNEL_HEALTH_RECORDS + 5; index++) {
      store.recordTgChannelHealth({
        channel: "ringchan",
        at: 1_700_000_000_000 + index,
        ok: index % 2 === 0,
        elapsedMs: index,
        resultsCount: index,
        source: "search",
      });
    }
    const summary = store.getTgChannelHealthSummary("ringchan")!;
    expect(summary.recent).toHaveLength(MAX_TG_CHANNEL_HEALTH_RECORDS);
    expect(summary.recent[0]!.at).toBe(1_700_000_000_000 + 5);
    expect(summary.recent.at(-1)!.at).toBe(1_700_000_000_000 + 24);
    expect(summary.successRate).toBeCloseTo(0.5, 5);
  });

  it("failureKind 取最近一条带分类的记录", async () => {
    const store = await freshStore();
    store.recordTgChannelHealth({
      channel: "kindchan", ok: false, elapsedMs: 10, resultsCount: 0, failureKind: "network_error", source: "search",
    });
    store.recordTgChannelHealth({
      channel: "kindchan", ok: true, elapsedMs: 10, resultsCount: 2, source: "search",
    });
    expect(store.getTgChannelHealthSummary("kindchan")!.failureKind).toBe("network_error");
  });

  it("消息与分类有界清洗，非法频道被忽略", async () => {
    const store = await freshStore();
    store.recordTgChannelHealth({
      channel: "longchan", ok: false, elapsedMs: 10, resultsCount: 0,
      failureKind: "k".repeat(200), message: "m".repeat(1000), source: "search",
    });
    const summary = store.getTgChannelHealthSummary("longchan")!;
    expect(summary.lastMessage).toHaveLength(300);
    store.recordTgChannelHealth({
      channel: "bad name!", ok: false, elapsedMs: 10, resultsCount: 0, source: "search",
    });
    store.recordTgChannelHealth({
      channel: "okchan", ok: true, elapsedMs: 10, resultsCount: 1, source: "search",
    });
    expect(Object.keys(store.getAllTgChannelHealthSummaries()).sort()).toEqual(["longchan", "okchan"]);
  });

  it("频道总数封顶，淘汰最久未检查的频道", async () => {
    const store = await freshStore();
    for (let index = 0; index <= MAX_TG_CHANNEL_HEALTH_CHANNELS; index++) {
      store.recordTgChannelHealth({
        channel: `chan${String(index).padStart(3, "0")}x`,
        at: 1_700_000_000_000 + index,
        ok: true, elapsedMs: 10, resultsCount: 1, source: "search",
      });
    }
    const all = store.getAllTgChannelHealthSummaries();
    expect(Object.keys(all)).toHaveLength(MAX_TG_CHANNEL_HEALTH_CHANNELS);
    expect(all["chan000x"]).toBeUndefined();
    expect(all["chan001x"]).toBeDefined();
    expect(all["chan500x"]).toBeDefined();
  });

  it("从 SQLite 恢复并清洗历史快照", async () => {
    const store = await freshStore();
    const db = (await import("../../server/core/storage/sqlite")).getSqliteDatabase();
    db.set("tg_channel_health", "state", {
      goodchan: [
        { at: 1_700_000_000_000, ok: true, elapsedMs: 50, resultsCount: 1, source: "probe" },
        { at: 1_700_000_001_000, ok: false, elapsedMs: 80, resultsCount: 0, failureKind: "channel_not_found", source: "probe" },
        { at: "bad", ok: true, source: "probe" },
        { at: 1_700_000_002_000, ok: true, elapsedMs: 10, resultsCount: 0, source: "nope" },
      ],
      "bad key!": [{ at: 1, ok: true, elapsedMs: 1, resultsCount: 1, source: "search" }],
      brokenchan: "nope",
    });
    const restored = store;
    const summary = restored.getTgChannelHealthSummary("goodchan")!;
    expect(summary.recent).toHaveLength(2);
    expect(summary.lastState).toBe("error");
    expect(summary.failureKind).toBe("channel_not_found");
    expect(Object.keys(restored.getAllTgChannelHealthSummaries())).toEqual(["goodchan"]);
  });

  it("损坏或非对象快照清洗为空", async () => {
    const store = await freshStore();
    expect(store.sanitizeTgChannelHealthSnapshot("not json")).toEqual({});
    expect(store.sanitizeTgChannelHealthSnapshot(null)).toEqual({});
  });

  it("SQLite flush 是幂等的，记录会立即持久化", async () => {
    const store = await freshStore();
    expect(store.flushTgChannelHealth()).toBe(true);
    store.recordTgChannelHealth({ channel: "flushchan", ok: true, elapsedMs: 10, resultsCount: 1, source: "probe" });
    expect(store.flushTgChannelHealth()).toBe(true);
    expect(store.getTgChannelHealthSummary("flushchan")?.recent).toHaveLength(1);
  });
});
