import { describe, expect, it } from "vitest";
import {
  buildMonitorRows,
  checkedAtText,
  channelMetrics,
  extractMonitorData,
  filterRows,
  relativeTime,
  summarizeRows,
  upstreamMetrics,
  withChannelEnabled,
  withRowRemoved,
  withRowRestored,
  withUpstreamEnabled,
  type MonitorData,
  type MonitorRow,
} from "../../components/monitor/monitorView";

function upstream(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "hunhepan",
    name: "混合盘",
    kind: "code",
    enabled: true,
    trashed: false,
    version: "1.0.0",
    health: {
      healthy: true,
      circuitState: "closed",
      requestCount: 10,
      successCount: 9,
      failureCount: 1,
      zeroResultCount: 0,
      lastSuccessAt: "2026-09-12T08:00:00.000Z",
      lastFailureAt: null,
      lastErrorMessage: null,
      dimensions: null,
      history: null,
    },
    ...overrides,
  };
}

function channel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel: "@panhub_share",
    origin: "builtin",
    enabled: true,
    deleted: false,
    policy: null,
    health: {
      state: "available",
      failureKind: null,
      lastCheckedAt: "2026-09-12T08:00:00.000Z",
      elapsedMs: 320,
      resultsCount: 12,
      message: null,
      successRate: 96.4,
      recent: [],
    },
    ...overrides,
  };
}

function data(overrides: Partial<MonitorData> = {}): MonitorData {
  return {
    generatedAt: "2026-09-12T09:00:00.000Z",
    upstreams: [upstream()],
    channels: [channel()],
    ...overrides,
  } as MonitorData;
}

function rowByKey(rows: MonitorRow[], key: string): MonitorRow {
  const row = rows.find((item) => item.key === key);
  if (!row) throw new Error(`missing row ${key}`);
  return row;
}

describe("extractMonitorData", () => {
  it("returns empty defaults for null / garbage payloads", () => {
    expect(extractMonitorData(null)).toEqual({
      generatedAt: "",
      upstreams: [],
      channels: [],
    });
    expect(extractMonitorData("oops")).toEqual({
      generatedAt: "",
      upstreams: [],
      channels: [],
    });
  });

  it("reads both the { code, data } envelope and flat shapes", () => {
    const wrapped = extractMonitorData({ code: 0, data: data() });
    expect(wrapped.upstreams).toHaveLength(1);
    expect(wrapped.channels).toHaveLength(1);
    expect(wrapped.generatedAt).toBe("2026-09-12T09:00:00.000Z");

    const flat = extractMonitorData({ upstreams: [upstream()] });
    expect(flat.upstreams).toHaveLength(1);
    expect(flat.channels).toEqual([]);
  });

  it("tolerates non-array fields", () => {
    const extracted = extractMonitorData({ data: { upstreams: "nope", channels: 3 } });
    expect(extracted.upstreams).toEqual([]);
    expect(extracted.channels).toEqual([]);
  });
});

describe("buildMonitorRows", () => {
  it("merges upstreams and channels into unified rows", () => {
    const rows = buildMonitorRows(data());
    expect(rows).toHaveLength(2);
    expect(rowByKey(rows, "upstream:hunhepan").kind).toBe("upstream");
    expect(rowByKey(rows, "upstream:hunhepan").typeLabel).toBe("代码插件");
    expect(rowByKey(rows, "channel:panhub_share").name).toBe("@panhub_share");
    expect(rowByKey(rows, "channel:panhub_share").origin).toBe("builtin");
  });

  it("resolves upstream states: healthy / warning / error / disabled / trashed / unknown", () => {
    const rows = buildMonitorRows(
      data({
        upstreams: [
          upstream({ id: "a" }),
          upstream({
            id: "b",
            health: {
              healthy: true,
              dimensions: { network: { state: "fail" } },
            },
          }),
          upstream({ id: "c", health: { healthy: false } }),
          upstream({ id: "d", enabled: false }),
          upstream({ id: "e", trashed: true, enabled: false }),
          upstream({ id: "f", health: null }),
          upstream({ id: "g", health: { healthy: "yes" } }),
        ] as never,
      }),
    );
    expect(rowByKey(rows, "upstream:a").state).toBe("healthy");
    expect(rowByKey(rows, "upstream:b").state).toBe("warning");
    expect(rowByKey(rows, "upstream:c").state).toBe("error");
    expect(rowByKey(rows, "upstream:d").state).toBe("disabled");
    expect(rowByKey(rows, "upstream:e").state).toBe("trashed");
    expect(rowByKey(rows, "upstream:f").state).toBe("unknown");
    // 非 boolean 的 healthy 兜底为未知而不是报错
    expect(rowByKey(rows, "upstream:g").state).toBe("unknown");
  });

  it("resolves channel states from health.state and flags", () => {
    const rows = buildMonitorRows(
      data({
        channels: [
          channel({ channel: "a" }),
          channel({ channel: "b", health: { state: "warning" } }),
          channel({ channel: "c", health: { state: "error" } }),
          channel({ channel: "d", enabled: false }),
          channel({ channel: "e", deleted: true }),
          channel({ channel: "f", health: null }),
        ] as never,
      }),
    );
    expect(rowByKey(rows, "channel:a").state).toBe("healthy");
    expect(rowByKey(rows, "channel:b").state).toBe("warning");
    expect(rowByKey(rows, "channel:c").state).toBe("error");
    expect(rowByKey(rows, "channel:d").state).toBe("disabled");
    expect(rowByKey(rows, "channel:e").state).toBe("trashed");
    expect(rowByKey(rows, "channel:f").state).toBe("unknown");
  });

  it("skips entries without ids and carries error details", () => {
    const rows = buildMonitorRows(
      data({
        upstreams: [upstream({ id: "", name: "no id" }), upstream({ id: "x", health: { healthy: false, lastErrorMessage: "boom" } })] as never,
        channels: [],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rowByKey(rows, "upstream:x").detail).toBe("boom");
  });
});

describe("summarizeRows", () => {
  it("counts upstreams and channels separately", () => {
    const summary = summarizeRows(
      buildMonitorRows(
        data({
          upstreams: [upstream({ id: "a" }), upstream({ id: "b", enabled: false }), upstream({ id: "c", health: { healthy: false } })] as never,
          channels: [channel({ channel: "x" }), channel({ channel: "y", deleted: true })] as never,
        }),
      ),
    );
    expect(summary.total).toBe(5);
    expect(summary.healthy).toBe(2);
    expect(summary.error).toBe(1);
    expect(summary.inactive).toBe(1);
    expect(summary.trashed).toBe(1);
    expect(summary.upstreams).toEqual({ total: 3, healthy: 1, warning: 0, error: 1, inactive: 1, trashed: 0 });
    expect(summary.channels).toEqual({ total: 2, healthy: 1, warning: 0, error: 0, inactive: 0, trashed: 1 });
  });
});

describe("filterRows", () => {
  const rows = buildMonitorRows(
    data({
      upstreams: [
        upstream(),
        upstream({ id: "b", name: "备用源", health: { healthy: false, lastErrorMessage: "boom" } }),
        upstream({ id: "c", name: "冷备源", enabled: false }),
      ] as never,
      channels: [channel({ channel: "share" })],
    }),
  );

  it("filters by kind and state", () => {
    expect(filterRows(rows, "all", "")).toHaveLength(4);
    expect(filterRows(rows, "upstream", "").every((row) => row.kind === "upstream")).toBe(true);
    expect(filterRows(rows, "channel", "").map((row) => row.id)).toEqual(["share"]);
    expect(filterRows(rows, "error", "").map((row) => row.key)).toEqual(["upstream:b"]);
    expect(filterRows(rows, "inactive", "").map((row) => row.key)).toEqual(["upstream:c"]);
  });

  it("matches name, id and detail text case-insensitively", () => {
    expect(filterRows(rows, "all", "SHARE")).toHaveLength(1);
    expect(filterRows(rows, "all", "混合盘")).toHaveLength(1);
    expect(filterRows(rows, "all", "hunhepan")).toHaveLength(1);
    expect(filterRows(rows, "all", "boom")).toHaveLength(1);
    expect(filterRows(rows, "all", "  ")).toHaveLength(4);
  });
});

describe("optimistic row updates", () => {
  const rows = buildMonitorRows(
    data({
      upstreams: [upstream({ id: "a" }), upstream({ id: "warn", health: { healthy: true, dimensions: { http: { state: "fail" } } } }), upstream({ id: "off", enabled: false, health: { healthy: false } })] as never,
      channels: [channel({ channel: "share" }), channel({ channel: "gone", deleted: true })] as never,
    }),
  );

  it("disables and re-enables upstreams while preserving health signals", () => {
    const disabled = withUpstreamEnabled(rows, "a", false);
    expect(rowByKey(disabled, "upstream:a").state).toBe("disabled");
    const restored = withUpstreamEnabled(disabled, "a", true);
    expect(rowByKey(restored, "upstream:a").state).toBe("healthy");

    const warnBack = withUpstreamEnabled(disabled, "warn", true);
    expect(rowByKey(warnBack, "upstream:warn").state).toBe("warning");
    expect(rowByKey(withUpstreamEnabled(rows, "off", true), "upstream:off").state).toBe("error");
    expect(rows.find((row) => row.key === "upstream:a")!.enabled).toBe(true);
  });

  it("disables and restores channels", () => {
    const disabled = withChannelEnabled(rows, "share", false);
    expect(rowByKey(disabled, "channel:share").state).toBe("disabled");
    const restored = withChannelEnabled(disabled, "share", true);
    expect(rowByKey(restored, "channel:share").state).toBe("healthy");
    // 已删除频道重新启用 = 恢复
    const revived = withRowRestored(rows, "channel:gone");
    const gone = rowByKey(revived, "channel:gone");
    expect(gone.trashed).toBe(false);
    expect(gone.enabled).toBe(true);
    expect(gone.state).toBe("healthy");
  });

  it("marks rows removed without mutating the input", () => {
    const removed = withRowRemoved(rows, "upstream:a");
    expect(rowByKey(removed, "upstream:a").state).toBe("trashed");
    expect(rowByKey(rows, "upstream:a").state).toBe("healthy");
    expect(removed).not.toBe(rows);
  });
});

describe("metric and time helpers", () => {
  it("falls back to placeholder metrics when health is missing", () => {
    expect(upstreamMetrics(null)).toEqual(["暂无健康数据"]);
    expect(channelMetrics(undefined)).toEqual(["暂无检测数据"]);
    expect(upstreamMetrics({ healthy: true, circuitState: "open", requestCount: 4, successCount: 1, zeroResultCount: 2 })).toEqual([
      "请求 4 · 成功率 25%",
      "零结果 2",
      "熔断 已熔断",
    ]);
    expect(channelMetrics({ state: "error", elapsedMs: 800, resultsCount: 0, failureKind: "timeout", successRate: 40 })).toEqual([
      "状态 异常",
      "800 ms · 结果 0",
      "成功率 40%",
      "失败分类 timeout",
    ]);
  });

  it("renders checked-at placeholders for missing or invalid values", () => {
    expect(checkedAtText({ checkedAtLabel: "" } as MonitorRow)).toBe("—");
    expect(relativeTime("")).toBe("—");
    expect(relativeTime("not-a-date")).toBe("—");
    const now = Date.parse("2026-09-12T10:00:00.000Z");
    expect(relativeTime("2026-09-12T09:59:30.000Z", now)).toBe("刚刚");
    expect(relativeTime("2026-09-12T09:30:00.000Z", now)).toBe("30 分钟前");
    expect(relativeTime("2026-09-12T06:00:00.000Z", now)).toBe("4 小时前");
    expect(relativeTime("2026-09-09T10:00:00.000Z", now)).toBe("3 天前");
  });

  it("treats numeric timestamps as epoch milliseconds (backend contract)", () => {
    const now = Date.parse("2026-09-12T10:00:00.000Z");
    expect(relativeTime(now - 30_000, now)).toBe("刚刚");
    expect(relativeTime(now - 30 * 60_000, now)).toBe("30 分钟前");
    expect(relativeTime(now - 4 * 3_600_000, now)).toBe("4 小时前");
    expect(relativeTime(Number.NaN, now)).toBe("—");

    const rows = buildMonitorRows(
      data({
        upstreams: [upstream({ id: "n", health: { healthy: true, lastSuccessAt: now, lastFailureAt: now - 1000 } })] as never,
        channels: [channel({ channel: "num", health: { state: "available", lastCheckedAt: now, elapsedMs: 88, resultsCount: 3 } })] as never,
      }),
    );
    const upstreamRow = rowByKey(rows, "upstream:n");
    expect(upstreamRow.checkedAtLabel).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
    const channelRow = rowByKey(rows, "channel:num");
    expect(channelRow.checkedAtLabel).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(checkedAtText(channelRow)).not.toBe("—");
  });
});
