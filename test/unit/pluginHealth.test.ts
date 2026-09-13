import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_BUCKET_CATEGORIES,
  MAX_DIMENSION_SAMPLES,
  MAX_ERROR_CATEGORIES,
  MAX_HISTORY_BUCKETS,
  PluginHealthChecker,
  phaseForCategory,
  sanitizeCategoryCounts,
  sanitizeHistoryBuckets,
} from "../../server/core/plugins/pluginHealth";

function createChecker() {
  return new PluginHealthChecker({
    maxFailures: 2,
    circuitBreakerTimeoutMs: 1_000,
    responseTimeThresholdMs: 10_000,
  });
}

describe("PluginHealthChecker", () => {
  afterEach(() => vi.useRealTimers());

  it("opens after consecutive failures and allows one half-open probe", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T00:00:00.000Z"));
    const checker = createChecker();

    checker.recordFailure("source");
    expect(checker.canExecute("source")).toBe(true);
    checker.recordFailure("source");
    expect(checker.getStatus("source")?.circuitState).toBe("open");
    expect(checker.canExecute("source")).toBe(false);

    vi.advanceTimersByTime(1_001);
    expect(checker.canExecute("source")).toBe(true);
    expect(checker.getStatus("source")?.circuitState).toBe("half-open");
    expect(checker.canExecute("source")).toBe(false);

    checker.recordSuccess("source", 25);
    expect(checker.getStatus("source")).toMatchObject({
      circuitState: "closed",
      isHealthy: true,
      failureCount: 0,
      successCount: 1,
      totalFailureCount: 2,
    });
    expect(checker.canExecute("source")).toBe(true);
  });

  it("reopens immediately when the half-open probe fails", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T00:00:00.000Z"));
    const checker = createChecker();
    checker.recordFailure("source");
    checker.recordFailure("source");

    vi.advanceTimersByTime(1_001);
    expect(checker.canExecute("source")).toBe(true);
    checker.recordFailure("source");

    expect(checker.getStatus("source")?.circuitState).toBe("open");
    expect(checker.canExecute("source")).toBe(false);
  });

  it("resets consecutive failures after any successful execution", () => {
    const checker = createChecker();
    checker.recordFailure("source");
    checker.recordSuccess("source", 10);
    checker.recordFailure("source");

    expect(checker.getStatus("source")).toMatchObject({
      circuitState: "closed",
      failureCount: 1,
      totalFailureCount: 2,
    });
  });

  it("tracks latency percentiles, zero results and categorized failures", () => {
    const checker = createChecker();
    checker.recordSuccess("source", 10, { resultCount: 2 });
    checker.recordSuccess("source", 30, { resultCount: 0 });
    checker.recordFailure("source", {
      responseTimeMs: 50,
      errorCategory: "timeout_error",
      errorMessage: "request timed out",
    });

    expect(checker.getStatus("source")).toMatchObject({
      requestCount: 3,
      successCount: 2,
      totalFailureCount: 1,
      resultCount: 2,
      zeroResultCount: 1,
      avgResponseTime: 30,
      p50ResponseTime: 30,
      p95ResponseTime: 50,
      parsingSuccessRate: 2 / 3,
      errorCounts: { timeout_error: 1 },
      lastErrorCategory: "timeout_error",
      lastErrorMessage: "request timed out",
    });
  });

});

describe("five-dimension health model", () => {
  it("derives all-pass dimensions from a default successful check", () => {
    const checker = createChecker();
    checker.recordSuccess("source", 10, { resultCount: 3 });

    const dims = checker.getStatus("source")!.dimensions!;
    expect(dims.network).toMatchObject({ state: "pass", passCount: 1, passRate: 1 });
    expect(dims.http.state).toBe("pass");
    expect(dims.business.state).toBe("pass");
    expect(dims.parsing.state).toBe("pass");
    expect(dims.results.state).toBe("pass");
  });

  it("marks zero-result checks as empty on the results dimension only", () => {
    const checker = createChecker();
    checker.recordSuccess("source", 10);

    const dims = checker.getStatus("source")!.dimensions!;
    expect(dims.network.state).toBe("pass");
    expect(dims.parsing.state).toBe("pass");
    expect(dims.results.state).toBe("empty");
    expect(dims.results.emptyCount).toBe(1);
    expect(dims.results.lastMessage).toBe("搜索成功但返回 0 条结果");
  });

  it("attributes an explicit businessOk=false to the business dimension", () => {
    const checker = createChecker();
    checker.recordSuccess("source", 10, {
      resultCount: 5,
      businessOk: false,
      httpStatus: 403,
    });

    const dims = checker.getStatus("source")!.dimensions!;
    expect(dims.network.state).toBe("pass");
    expect(dims.http.state).toBe("pass");
    expect(dims.business.state).toBe("fail");
    expect(dims.business.lastMessage).toBe("业务状态异常 (HTTP 403)");
    expect(dims.parsing.state).toBe("unknown");
    expect(dims.results.state).toBe("unknown");
  });

  it("attributes an explicit parseOk=false to the parsing dimension", () => {
    const checker = createChecker();
    checker.recordSuccess("source", 10, { parseOk: false });

    const dims = checker.getStatus("source")!.dimensions!;
    expect(dims.network.state).toBe("pass");
    expect(dims.http.state).toBe("pass");
    expect(dims.business.state).toBe("pass");
    expect(dims.parsing.state).toBe("fail");
    expect(dims.results.state).toBe("unknown");
  });

  it("maps default error categories to failure phases", () => {
    expect(phaseForCategory("network_error")).toBe("network");
    expect(phaseForCategory("timeout_error")).toBe("network");
    expect(phaseForCategory("http_error")).toBe("http");
    expect(phaseForCategory("business_error")).toBe("business");
    expect(phaseForCategory("validation_error")).toBe("business");
    expect(phaseForCategory("parse_error")).toBe("parsing");
    expect(phaseForCategory("plugin_error")).toBe("unknown");
    expect(phaseForCategory("mystery")).toBe("unknown");
  });

  it("attributes failures to the matching phase from the error category", () => {
    const checker = createChecker();
    checker.recordFailure("timeout", { errorCategory: "timeout_error", errorMessage: "超时" });
    checker.recordFailure("http", { errorCategory: "http_error", httpStatus: 503, errorMessage: "boom" });
    checker.recordFailure("business", { errorCategory: "validation_error" });
    checker.recordFailure("parsing", { errorCategory: "parse_error" });

    const timeoutDims = checker.getStatus("timeout")!.dimensions!;
    expect(timeoutDims.network.state).toBe("fail");
    expect(timeoutDims.http.state).toBe("unknown");
    expect(timeoutDims.results.state).toBe("unknown");

    const httpDims = checker.getStatus("http")!.dimensions!;
    expect(httpDims.network.state).toBe("pass");
    expect(httpDims.http.state).toBe("fail");
    expect(httpDims.http.lastMessage).toBe("HTTP 503: boom");
    expect(httpDims.business.state).toBe("unknown");

    const businessDims = checker.getStatus("business")!.dimensions!;
    expect(businessDims.network.state).toBe("pass");
    expect(businessDims.http.state).toBe("pass");
    expect(businessDims.business.state).toBe("fail");
    expect(businessDims.parsing.state).toBe("unknown");

    const parsingDims = checker.getStatus("parsing")!.dimensions!;
    expect(parsingDims.parsing.state).toBe("fail");
    expect(parsingDims.business.state).toBe("pass");
    expect(parsingDims.results.state).toBe("unknown");
  });

  it("honours an explicit phase over the category-derived one", () => {
    const checker = createChecker();
    checker.recordFailure("source", {
      errorCategory: "timeout_error",
      phase: "http",
      httpStatus: 429,
    });

    const dims = checker.getStatus("source")!.dimensions!;
    expect(dims.network.state).toBe("pass");
    expect(dims.http.state).toBe("fail");
  });

  it("leaves dimensions untouched when the failure phase is unknown", () => {
    const checker = createChecker();
    checker.recordFailure("source", { errorCategory: "unknown_error" });

    const dims = checker.getStatus("source")!.dimensions!;
    for (const key of ["network", "http", "business", "parsing", "results"] as const) {
      expect(dims[key].state).toBe("unknown");
      expect(dims[key].recent).toBe("");
    }
    expect(checker.getStatus("source")!.requestCount).toBe(1);
  });

  it("recovers dimension state after a failure is followed by success", () => {
    const checker = createChecker();
    checker.recordFailure("source", { errorCategory: "timeout_error" });
    checker.recordSuccess("source", 20, { resultCount: 1 });

    const dims = checker.getStatus("source")!.dimensions!;
    expect(dims.network.state).toBe("pass");
    expect(dims.network.recent).toBe("01");
    expect(dims.network.passRate).toBe(0.5);
    expect(dims.results.state).toBe("pass");
  });

  it("keeps the per-dimension sample window bounded", () => {
    const checker = createChecker();
    for (let index = 0; index < MAX_DIMENSION_SAMPLES + 10; index++) {
      checker.recordSuccess("source", 5, { resultCount: 1 });
    }

    const dims = checker.getStatus("source")!.dimensions!;
    expect(dims.network.recent).toHaveLength(MAX_DIMENSION_SAMPLES);
    expect(dims.network.passCount).toBe(MAX_DIMENSION_SAMPLES);
    expect(dims.network.failCount).toBe(0);
  });

  it("bounds accumulated error categories on the write path", () => {
    const checker = createChecker();
    for (let index = 0; index < MAX_ERROR_CATEGORIES + 10; index++) {
      checker.recordFailure("source", { errorCategory: `category_${index}` });
    }

    const status = checker.getStatus("source")!;
    expect(Object.keys(status.errorCounts)).toHaveLength(MAX_ERROR_CATEGORIES);
    expect(status.totalFailureCount).toBe(MAX_ERROR_CATEGORIES + 10);
  });
});

describe("hourly history trend", () => {
  it("aggregates checks into hourly buckets with outcome counts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T10:10:00.000Z"));
    const checker = createChecker();
    checker.recordSuccess("source", 10, { resultCount: 2 });
    checker.recordSuccess("source", 10);
    checker.recordFailure("source", { errorCategory: "timeout_error" });

    vi.advanceTimersByTime(2 * 3_600_000);
    checker.recordFailure("source", { errorCategory: "http_error", httpStatus: 503 });

    const buckets = checker.getStatus("source")!.history!.buckets;
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toMatchObject({ n: 3, s: 2, f: 1, z: 1 });
    expect(buckets[0]!.e).toEqual({ timeout_error: 1 });
    expect(buckets[1]).toMatchObject({ n: 1, s: 0, f: 1 });
    expect(buckets[1]!.e).toEqual({ http_error: 1 });
  });

  it("keeps only the most recent buckets", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T00:30:00.000Z"));
    const checker = createChecker();
    for (let hour = 0; hour < MAX_HISTORY_BUCKETS + 5; hour++) {
      checker.recordSuccess("source", 5, { resultCount: 1 });
      vi.advanceTimersByTime(3_600_000);
    }

    const buckets = checker.getStatus("source")!.history!.buckets;
    expect(buckets).toHaveLength(MAX_HISTORY_BUCKETS);
    expect(buckets[0]!.t).toBe(Date.UTC(2026, 8, 11, 5, 0, 0));
  });

  it("merges overflowing failure categories into other", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T00:00:00.000Z"));
    const checker = createChecker();
    const categories = ["a1", "b2", "c3", "d4", "e5", "f6", "g7", "h8"];
    for (const category of categories) {
      checker.recordFailure("source", { errorCategory: category });
      vi.advanceTimersByTime(1);
    }

    const bucket = checker.getStatus("source")!.history!.buckets[0]!;
    const keys = Object.keys(bucket.e!);
    expect(bucket.f).toBe(categories.length);
    expect(keys).toHaveLength(MAX_BUCKET_CATEGORIES + 1);
    expect(bucket.e!.other).toBe(categories.length - MAX_BUCKET_CATEGORIES);
  });
});

describe("snapshot bounding helpers", () => {
  it("keeps only the largest category counts and drops invalid values", () => {
    const raw: Record<string, number> = { keep_small: 1 };
    for (let index = 0; index < MAX_ERROR_CATEGORIES + 5; index++) {
      raw[`cat_${index}`] = index + 10;
    }
    raw.bad_zero = 0;
    raw.bad_negative = -3;
    raw.bad_nan = Number.NaN;

    const counts = sanitizeCategoryCounts(raw);
    expect(Object.keys(counts)).toHaveLength(MAX_ERROR_CATEGORIES);
    expect(counts.keep_small).toBeUndefined();
    expect(counts.cat_19).toBe(29);
  });

  it("merges same-hour buckets, drops invalid entries and bounds the window", () => {
    const hour = Date.UTC(2026, 8, 11, 3, 0, 0);
    const merged = sanitizeHistoryBuckets([
      { t: hour, n: 2, s: 1, f: 1, z: 1, e: { timeout_error: 1 } },
      null,
      "junk",
      { t: "bad", n: 5 },
      { t: hour + 1000, n: 1, s: 1, f: 0, z: 0, e: { timeout_error: 2, parse_error: 1 } },
      { t: hour - 30 * 3_600_000, n: 1, f: 1, e: { http_error: 1 } },
    ]);

    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({ n: 3, s: 2, f: 1, z: 1 });
    expect(merged[1]!.e).toEqual({ timeout_error: 3, parse_error: 1 });
    expect(merged[0]).toMatchObject({ n: 1, f: 1 });
  });
});

it("releases a cancelled half-open probe without changing failure statistics", () => {
  vi.useFakeTimers();
  try {
    const checker = createChecker();
    checker.recordFailure("source"); checker.recordFailure("source");
    vi.advanceTimersByTime(1001);
    expect(checker.canExecute("source")).toBe(true);
    checker.releaseProbe("source");
    expect(checker.getStatus("source")).toMatchObject({ circuitState: "half-open", totalFailureCount: 2 });
    expect(checker.canExecute("source")).toBe(true);
    expect(checker.canExecute("source")).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
