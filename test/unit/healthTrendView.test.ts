import { describe, expect, it } from "vitest";
import {
  buildDimensionRows,
  buildFailureRows,
  buildOverviewSummary,
  buildTrendRows,
  circuitLabel,
} from "../../components/upstreams/serverHealthView";
import type { PluginHealthHourlyBucket } from "../../server/core/plugins/pluginHealth";

function bucket(
  overrides: Partial<PluginHealthHourlyBucket>
): PluginHealthHourlyBucket {
  return { t: 0, n: 0, s: 0, f: 0, z: 0, ...overrides };
}

describe("buildTrendRows", () => {
  it("normalizes bar heights against the busiest hour", () => {
    const rows = buildTrendRows([
      bucket({ t: Date.UTC(2026, 8, 11, 2), n: 10, s: 8, f: 2 }),
      bucket({ t: Date.UTC(2026, 8, 11, 3), n: 4, s: 4 }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ height: 100, successPct: 80, zeroPct: 0 });
    expect(rows[1]).toMatchObject({ height: 40, successPct: 100 });
    expect(rows[0]!.title).toContain("检查 10");
    expect(rows[0]!.title).toContain("失败 2");
    expect(rows[1]!.title).not.toContain("零结果");
  });

  it("labels zero-result portions and renders empty input as no rows", () => {
    const rows = buildTrendRows([
      bucket({ t: Date.UTC(2026, 8, 11, 5), n: 2, s: 1, z: 1 }),
    ]);
    expect(rows[0]!.zeroPct).toBe(50);
    expect(rows[0]!.title).toContain("零结果 1");
    expect(buildTrendRows([])).toEqual([]);
  });

  it("formats hour labels with the local timezone", () => {
    const rows = buildTrendRows([bucket({ t: Date.UTC(2026, 8, 11, 12) })]);
    expect(rows[0]!.hourLabel).toBe(
      `${String(new Date(Date.UTC(2026, 8, 11, 12)).getHours()).padStart(2, "0")}:00`
    );
  });
});

describe("buildFailureRows", () => {
  it("aggregates category counts across buckets and ranks them", () => {
    const rows = buildFailureRows([
      bucket({ t: 1, f: 3, e: { timeout_error: 2, parse_error: 1 } }),
      bucket({ t: 2, f: 4, e: { timeout_error: 1, http_error: 3 } }),
    ]);

    expect(rows.map((row) => row.category)).toEqual([
      "http_error",
      "timeout_error",
      "parse_error",
    ]);
    expect(rows[0]).toMatchObject({ label: "HTTP 错误", count: 3, width: 100 });
    expect(rows[1]).toMatchObject({ label: "请求超时", count: 3, width: 100 });
    expect(rows[2]).toMatchObject({ label: "解析失败", count: 1, width: 33 });
  });

  it("falls back to accumulated error counts when no buckets exist", () => {
    const rows = buildFailureRows([], { unknown_error: 2, timeout_error: 5 });
    expect(rows.map((row) => row.category)).toEqual([
      "timeout_error",
      "unknown_error",
    ]);
    expect(rows[0]!.label).toBe("请求超时");
    expect(rows[1]!.label).toBe("未知错误");
  });

  it("keeps unknown categories as raw labels and limits output to six", () => {
    const raw: Record<string, number> = {};
    for (let index = 0; index < 8; index++) raw[`weird_${index}`] = index + 1;
    const rows = buildFailureRows([bucket({ f: 36, e: raw })]);
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({ label: "weird_7", count: 8 });
  });
});

describe("buildDimensionRows", () => {
  it("reports the five dimensions with bounded-window pass rates", () => {
    const rows = buildDimensionRows({
      name: "source",
      dimensions: {
        network: {
          state: "pass",
          passCount: 3,
          failCount: 1,
          emptyCount: 0,
          recent: "1110",
          passRate: 0.75,
        },
        results: {
          state: "empty",
          passCount: 2,
          failCount: 0,
          emptyCount: 2,
          recent: "11ee",
          passRate: 0.5,
        },
      },
    } as any);

    expect(rows.map((row) => row.key)).toEqual([
      "network",
      "http",
      "business",
      "parsing",
      "results",
    ]);
    expect(rows[0]).toMatchObject({ label: "网络可达", state: "pass", rate: "75%" });
    expect(rows[1]).toMatchObject({ state: "unknown", rate: "—" });
    expect(rows[4]).toMatchObject({ label: "搜索结果", state: "empty", rate: "50%" });
  });

  it("returns no rows without a status", () => {
    expect(buildDimensionRows(undefined)).toEqual([]);
  });
});

describe("buildOverviewSummary", () => {
  it("sums checks, failures and zero results across the trend window", () => {
    const summary = buildOverviewSummary({
      healthy: 8,
      total: 10,
      trend: {
        windowHours: 24,
        buckets: [
          bucket({ n: 5, s: 4, f: 1 }),
          bucket({ n: 3, s: 2, f: 1, z: 1 }),
        ],
      },
    });

    expect(summary).toEqual({
      healthy: 8,
      total: 10,
      checks: 8,
      failures: 2,
      zeroResults: 1,
    });
  });

  it("tolerates a missing payload", () => {
    expect(buildOverviewSummary(null)).toBeNull();
  });
});

describe("circuitLabel", () => {
  it("maps circuit states to readable labels", () => {
    expect(circuitLabel("closed")).toBe("正常");
    expect(circuitLabel("open")).toBe("已熔断");
    expect(circuitLabel("half-open")).toBe("半开探测");
    expect(circuitLabel("weird")).toBe("weird");
    expect(circuitLabel(undefined)).toBe("未知");
  });
});
