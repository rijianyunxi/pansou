export type PluginCircuitState = "closed" | "open" | "half-open";

export interface PluginSuccessOptions {
  resultCount?: number;
  /**
   * 五维扩展（全部可选，缺省等价于 "该层通过"）：
   * - businessOk: 上游业务状态码是否正常；显式 false 时业务维度记为失败。
   * - parseOk: 响应结构是否可解析；显式 false 时解析维度记为失败。
   * - httpStatus: 已知的 HTTP 状态码（信息性记录）。
   */
  businessOk?: boolean;
  parseOk?: boolean;
  httpStatus?: number;
  /** 业务状态异常时的补充信息（记录到维度消息）。 */
  errorMessage?: string;
}

export type PluginFailurePhase = "network" | "http" | "business" | "parsing" | "unknown";

export interface PluginFailureOptions {
  responseTimeMs?: number;
  errorCategory?: string;
  errorMessage?: string;
  /**
   * 五维扩展（可选）：失败发生在请求管线的哪一层；缺省时按 errorCategory
   * 推导（phaseForCategory）。显式传 phase 的调用点无需更换错误分类。
   */
  phase?: PluginFailurePhase;
  /** 失败时已知的 HTTP 状态码（用于 http 层失败的展示）。 */
  httpStatus?: number;
}

/** 五维健康模型的维度：网络可达 / HTTP 正常 / 业务状态正常 / 结构可解析 / 搜索有结果。 */
export const DIMENSION_KEYS = [
  "network",
  "http",
  "business",
  "parsing",
  "results",
] as const;

export type PluginDimensionKey = (typeof DIMENSION_KEYS)[number];

/**
 * 单维度最近一次到达该层的检查结论：
 * - pass: 该层通过；fail: 该层失败；empty: 通过但无内容（仅 results 维度的零结果）；
 * - unknown: 本次检查未到达该层（例如网络失败时 HTTP 及以下未知）。
 */
export type PluginDimensionState = "pass" | "fail" | "empty" | "unknown";

/** 单维度健康状态。recent 环形样本同时作为持久化载体（有界字符串）。 */
export interface PluginDimensionStatus {
  state: PluginDimensionState;
  /** 有界窗口内（recent 样本）的通过占比，unknown 样本不参与计算。 */
  passRate: number;
  passCount: number;
  failCount: number;
  /** 仅 results 维度使用：搜索成功但零结果的次数。 */
  emptyCount: number;
  /** 最近样本（旧 → 新），"1"=pass、"0"=fail、"e"=empty，上限 MAX_DIMENSION_SAMPLES。 */
  recent: string;
  lastPassTime?: number;
  lastFailTime?: number;
  lastMessage?: string;
}

/** 按小时聚合的检查结果桶（有界，旧 → 新）。 */
export interface PluginHealthHourlyBucket {
  /** UTC 对齐的小时起点（epoch ms）。 */
  t: number;
  /** 该小时检查总数（= s + f）。 */
  n: number;
  /** 成功次数。 */
  s: number;
  /** 失败次数。 */
  f: number;
  /** 成功但零结果的次数。 */
  z: number;
  /** 失败原因分类计数（最多 MAX_BUCKET_CATEGORIES 项，溢出并入 "other"）。 */
  e?: Record<string, number>;
}

/** 有界健康历史趋势：按小时聚合，仅保留最近 MAX_HISTORY_BUCKETS 个桶。 */
export interface PluginHealthHistory {
  windowHours: number;
  buckets: PluginHealthHourlyBucket[];
}

/* ------------------------------------------------------------------ */
/* 有界常量：同时约束内存与磁盘快照体积（healthStore 持久化时复用）。 */
/* ------------------------------------------------------------------ */

export const HISTORY_BUCKET_MS = 3_600_000;
/** 历史趋势保留的小时桶数量。 */
export const MAX_HISTORY_BUCKETS = 24;
/** 每个维度保留的最近样本数。 */
export const MAX_DIMENSION_SAMPLES = 50;
/** 每个小时桶内最多区分的失败分类数。 */
export const MAX_BUCKET_CATEGORIES = 6;
/** 每个插件最多保留的错误分类数（累计 errorCounts）。 */
export const MAX_ERROR_CATEGORIES = 16;
/** 单条错误消息在维度/状态中保留的最大长度。 */
export const MAX_ERROR_MESSAGE_LENGTH = 300;

const HOUR_MS = HISTORY_BUCKET_MS;

/** 缺省错误分类 → 失败阶段映射；未知分类不归因到具体维度。 */
const DEFAULT_PHASE_BY_CATEGORY: Record<string, PluginFailurePhase> = {
  network_error: "network",
  timeout_error: "network",
  http_error: "http",
  business_error: "business",
  validation_error: "business",
  parse_error: "parsing",
};

/** 从既有 errorCategory 推导失败阶段；显式传 phase 的扩展调用点优先。 */
export function phaseForCategory(category: string): PluginFailurePhase {
  return DEFAULT_PHASE_BY_CATEGORY[category] || "unknown";
}

/** Runtime health, latency and circuit-breaker state for one plugin. */
export interface PluginHealthStatus {
  name: string;
  isHealthy: boolean;
  circuitState: PluginCircuitState;
  avgResponseTime: number;
  p50ResponseTime: number;
  p95ResponseTime: number;
  /** Consecutive failures. Reset after a successful execution. */
  failureCount: number;
  totalFailureCount: number;
  successCount: number;
  requestCount: number;
  zeroResultCount: number;
  resultCount: number;
  parsingSuccessRate: number;
  slowRequestCount: number;
  errorCounts: Record<string, number>;
  lastErrorCategory?: string;
  lastErrorMessage?: string;
  lastFailureTime?: number;
  lastSuccessTime?: number;
  /** 五维健康模型（网络/HTTP/业务/解析/结果），随检查实时更新。 */
  dimensions?: Record<PluginDimensionKey, PluginDimensionStatus>;
  /** 按小时聚合的有界历史趋势，随快照持久化。 */
  history?: PluginHealthHistory;
}

export interface PluginHealthConfig {
  maxFailures: number;
  circuitBreakerTimeoutMs: number;
  responseTimeThresholdMs: number;
  sampleSize?: number;
}

type InternalPluginHealthStatus = PluginHealthStatus & {
  halfOpenProbeInFlight: boolean;
  responseTimeSamples: number[];
};

function percentile(samples: readonly number[], value: number): number {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((value / 100) * sorted.length) - 1)
  );
  return sorted[index] || 0;
}

function toCount(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
}

function toTimestamp(value: unknown): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : undefined;
}

function clampMessage(value: unknown): string | undefined {
  return typeof value === "string" && value
    ? value.slice(0, MAX_ERROR_MESSAGE_LENGTH)
    : undefined;
}

/** 从 recent 环形样本重建计数与通过率（有界窗口统计）。 */
function recountDimension(dim: PluginDimensionStatus): void {
  let pass = 0;
  let fail = 0;
  let empty = 0;
  for (const ch of dim.recent) {
    if (ch === "1") pass++;
    else if (ch === "0") fail++;
    else if (ch === "e") empty++;
  }
  dim.passCount = pass;
  dim.failCount = fail;
  dim.emptyCount = empty;
  const total = pass + fail + empty;
  dim.passRate = total ? pass / total : 0;
}

function createDimension(): PluginDimensionStatus {
  return {
    state: "unknown",
    passRate: 0,
    passCount: 0,
    failCount: 0,
    emptyCount: 0,
    recent: "",
  };
}

function createDimensions(): Record<PluginDimensionKey, PluginDimensionStatus> {
  return {
    network: createDimension(),
    http: createDimension(),
    business: createDimension(),
    parsing: createDimension(),
    results: createDimension(),
  };
}

function isDimensionState(value: unknown): value is PluginDimensionState {
  return (
    value === "pass" || value === "fail" || value === "empty" || value === "unknown"
  );
}

/** 反序列化防护：校验/截断单维度状态，recent 只保留合法字符并限制长度。 */
function sanitizeDimension(raw: unknown): PluginDimensionStatus {
  const dim = createDimension();
  if (!raw || typeof raw !== "object") return dim;
  const source = raw as Partial<PluginDimensionStatus>;
  if (isDimensionState(source.state)) dim.state = source.state;
  dim.recent =
    typeof source.recent === "string"
      ? source.recent.slice(-MAX_DIMENSION_SAMPLES).replace(/[^10e]/g, "")
      : "";
  dim.lastPassTime = toTimestamp(source.lastPassTime);
  dim.lastFailTime = toTimestamp(source.lastFailTime);
  dim.lastMessage = clampMessage(source.lastMessage);
  recountDimension(dim);
  return dim;
}

function sanitizeDimensions(
  raw: unknown
): Record<PluginDimensionKey, PluginDimensionStatus> {
  const dims = createDimensions();
  if (!raw || typeof raw !== "object") return dims;
  const source = raw as Record<string, unknown>;
  for (const key of DIMENSION_KEYS) {
    dims[key] = sanitizeDimension(source[key]);
  }
  return dims;
}

/** 小时桶归并 + 有界裁剪：同小时合并、仅保留最近 MAX_HISTORY_BUCKETS 个。 */
export function sanitizeHistoryBuckets(
  raw: unknown
): PluginHealthHourlyBucket[] {
  if (!Array.isArray(raw)) return [];
  const byHour = new Map<number, PluginHealthHourlyBucket>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const bucket = item as Partial<PluginHealthHourlyBucket>;
    const t = Math.floor(Number(bucket.t) / HOUR_MS) * HOUR_MS;
    if (!Number.isFinite(t) || t <= 0) continue;
    const target = byHour.get(t) || { t, n: 0, s: 0, f: 0, z: 0, e: {} };
    target.n += toCount(bucket.n);
    target.s += toCount(bucket.s);
    target.f += toCount(bucket.f);
    target.z += toCount(bucket.z);
    const reasons = bucket.e && typeof bucket.e === "object" ? bucket.e : {};
    for (const [category, count] of Object.entries(reasons)) {
      target.e = target.e || {};
      target.e[category] = (target.e[category] || 0) + toCount(count);
    }
    if (target.e) {
      const entries = Object.entries(target.e).filter(([, count]) => count > 0);
      if (entries.length > MAX_BUCKET_CATEGORIES) {
        entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        const merged: Record<string, number> = {};
        let other = 0;
        for (const [index, [category, count]] of entries.entries()) {
          if (index < MAX_BUCKET_CATEGORIES) merged[category] = count;
          else other += count;
        }
        if (other > 0) merged.other = (merged.other || 0) + other;
        target.e = merged;
      }
    }
    byHour.set(t, target);
  }
  return [...byHour.values()]
    .sort((a, b) => a.t - b.t)
    .slice(-MAX_HISTORY_BUCKETS);
}

function sanitizeHistory(raw: unknown): PluginHealthHistory {
  return {
    windowHours: MAX_HISTORY_BUCKETS,
    buckets: sanitizeHistoryBuckets(
      raw && typeof raw === "object" ? (raw as PluginHealthHistory).buckets : raw
    ),
  };
}

/** 有界分类计数（累计 errorCounts）：仅保留计数最大的前 MAX_ERROR_CATEGORIES 项。 */
export function sanitizeCategoryCounts(
  raw: unknown
): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!raw || typeof raw !== "object") return counts;
  for (const [category, count] of Object.entries(raw as Record<string, unknown>)) {
    const value = toCount(count);
    if (value > 0) counts[category.slice(0, 64)] = value;
  }
  const entries = Object.entries(counts);
  if (entries.length <= MAX_ERROR_CATEGORIES) return counts;
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return Object.fromEntries(entries.slice(0, MAX_ERROR_CATEGORIES));
}

/**
 * 快照清洗：在持久化（healthStore.save/load）与导入（importSnapshot）边界上
 * 统一裁剪历史桶、维度样本和分类计数，保证磁盘快照体积有界。
 */
export function sanitizePluginHealthSnapshot(
  snapshot: Record<string, PluginHealthStatus>
): Record<string, PluginHealthStatus> {
  const out: Record<string, PluginHealthStatus> = {};
  for (const [name, status] of Object.entries(snapshot || {})) {
    if (!status || typeof status !== "object") continue;
    out[name.slice(0, 128)] = {
      ...status,
      name: name.slice(0, 128),
      errorCounts: sanitizeCategoryCounts(status.errorCounts),
      dimensions: sanitizeDimensions(status.dimensions),
      history: sanitizeHistory(status.history),
      lastErrorMessage: clampMessage(status.lastErrorMessage),
    };
  }
  return out;
}

function cloneDimensions(
  dimensions: Record<PluginDimensionKey, PluginDimensionStatus>
): Record<PluginDimensionKey, PluginDimensionStatus> {
  return Object.fromEntries(
    Object.entries(dimensions).map(([key, dim]) => [key, { ...dim }])
  ) as Record<PluginDimensionKey, PluginDimensionStatus>;
}

function cloneHistory(history: PluginHealthHistory): PluginHealthHistory {
  return {
    windowHours: history.windowHours,
    buckets: history.buckets.map((bucket) => ({
      ...bucket,
      e: bucket.e ? { ...bucket.e } : undefined,
    })),
  };
}

/**
 * Tracks plugin health and implements a closed → open → half-open circuit.
 * A cooled-down open circuit grants exactly one probe until that probe records
 * success or failure, preventing a traffic burst while an upstream recovers.
 *
 * 除熔断与延迟统计外，还为每次检查维护：
 * - 五维健康模型（dimensions）：网络可达 / HTTP 正常 / 业务状态正常 / 结构可解析 / 搜索有结果；
 * - 有界历史趋势（history）：按小时聚合的成功/失败/零结果/失败分类计数，
 *   随 exportSnapshot → healthStore 持久化，重启后经 importSnapshot 恢复。
 */
export class PluginHealthChecker {
  private healthMap = new Map<string, InternalPluginHealthStatus>();

  constructor(private readonly config: PluginHealthConfig) {}

  private createStatus(pluginName: string): InternalPluginHealthStatus {
    return {
      name: pluginName,
      isHealthy: true,
      circuitState: "closed",
      avgResponseTime: 0,
      p50ResponseTime: 0,
      p95ResponseTime: 0,
      failureCount: 0,
      totalFailureCount: 0,
      successCount: 0,
      requestCount: 0,
      zeroResultCount: 0,
      resultCount: 0,
      parsingSuccessRate: 0,
      slowRequestCount: 0,
      errorCounts: {},
      halfOpenProbeInFlight: false,
      responseTimeSamples: [],
      dimensions: createDimensions(),
      history: { windowHours: MAX_HISTORY_BUCKETS, buckets: [] },
    };
  }

  private recordResponseTime(
    current: InternalPluginHealthStatus,
    responseTimeMs: number
  ): void {
    const normalized = Math.max(0, Math.round(responseTimeMs));
    current.responseTimeSamples.push(normalized);
    const maxSamples = Math.max(10, this.config.sampleSize || 100);
    if (current.responseTimeSamples.length > maxSamples) {
      current.responseTimeSamples.splice(
        0,
        current.responseTimeSamples.length - maxSamples
      );
    }
    const sum = current.responseTimeSamples.reduce((total, item) => total + item, 0);
    current.avgResponseTime = sum / current.responseTimeSamples.length;
    current.p50ResponseTime = percentile(current.responseTimeSamples, 50);
    current.p95ResponseTime = percentile(current.responseTimeSamples, 95);
    if (normalized > this.config.responseTimeThresholdMs) {
      current.slowRequestCount++;
    }
  }

  private updateParsingSuccessRate(current: InternalPluginHealthStatus): void {
    current.parsingSuccessRate = current.requestCount
      ? current.successCount / current.requestCount
      : 0;
  }

  /** 更新单个维度的最近结论；unknown 不写入样本环。 */
  private applyDimension(
    current: InternalPluginHealthStatus,
    key: PluginDimensionKey,
    state: PluginDimensionState,
    now: number,
    message?: string
  ): void {
    const dim = current.dimensions![key];
    dim.state = state;
    if (state !== "unknown") {
      const sample = state === "pass" ? "1" : state === "fail" ? "0" : "e";
      dim.recent = (dim.recent + sample).slice(-MAX_DIMENSION_SAMPLES);
      recountDimension(dim);
      if (state === "pass") dim.lastPassTime = now;
      else dim.lastFailTime = now;
    }
    if (message !== undefined) {
      dim.lastMessage = clampMessage(message);
    }
  }

  private markDimensions(
    current: InternalPluginHealthStatus,
    updates: Partial<Record<PluginDimensionKey, PluginDimensionState>>,
    now: number,
    message?: string
  ): void {
    for (const key of DIMENSION_KEYS) {
      const state = updates[key];
      if (state) this.applyDimension(current, key, state, now, message);
    }
  }

  /** 追加一条检查记录到按小时聚合的有界历史。 */
  private appendHistory(
    current: InternalPluginHealthStatus,
    outcome: { success: boolean; zeroResult: boolean; category?: string },
    now: number
  ): void {
    const buckets = current.history!.buckets;
    const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
    let bucket: PluginHealthHourlyBucket | undefined;
    for (let index = buckets.length - 1; index >= 0; index--) {
      if (buckets[index]!.t === hourStart) {
        bucket = buckets[index];
        break;
      }
    }
    if (!bucket) {
      bucket = { t: hourStart, n: 0, s: 0, f: 0, z: 0 };
      buckets.push(bucket);
      if (buckets.length > MAX_HISTORY_BUCKETS) {
        buckets.sort((a, b) => a.t - b.t);
        buckets.splice(0, buckets.length - MAX_HISTORY_BUCKETS);
      }
    }
    bucket.n++;
    if (outcome.success) {
      bucket.s++;
      if (outcome.zeroResult) bucket.z++;
      return;
    }
    bucket.f++;
    const counts = (bucket.e = bucket.e || {});
    const category = outcome.category || "unknown_error";
    counts[category] = (counts[category] || 0) + 1;
    const entries = Object.entries(counts);
    if (entries.length > MAX_BUCKET_CATEGORIES) {
      entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const merged: Record<string, number> = {};
      let other = 0;
      for (const [index, [key, count]] of entries.entries()) {
        if (index < MAX_BUCKET_CATEGORIES) merged[key] = count;
        else other += count;
      }
      if (other > 0) merged.other = (merged.other || 0) + other;
      bucket.e = merged;
    }
  }

  recordSuccess(
    pluginName: string,
    responseTimeMs: number,
    options: PluginSuccessOptions = {}
  ): void {
    const current = this.healthMap.get(pluginName) || this.createStatus(pluginName);
    const now = Date.now();
    current.requestCount++;
    current.successCount++;
    current.lastSuccessTime = now;
    const resultCount = Math.max(0, Math.floor(options.resultCount || 0));
    current.resultCount += resultCount;
    if (!options.resultCount) current.zeroResultCount++;
    this.recordResponseTime(current, responseTimeMs);
    this.updateParsingSuccessRate(current);

    // 五维推导：一次成功默认网络/HTTP/业务/解析全部通过，零结果只影响结果维度。
    if (options.businessOk === false) {
      this.markDimensions(
        current,
        { network: "pass", http: "pass", business: "fail", parsing: "unknown", results: "unknown" },
        now,
        options.errorMessage || options.httpStatus
          ? `业务状态异常${options.httpStatus ? ` (HTTP ${options.httpStatus})` : ""}`
          : undefined
      );
    } else if (options.parseOk === false) {
      this.markDimensions(
        current,
        { network: "pass", http: "pass", business: "pass", parsing: "fail", results: "unknown" },
        now
      );
    } else {
      this.markDimensions(
        current,
        { network: "pass", http: "pass", business: "pass", parsing: "pass" },
        now
      );
      this.applyDimension(
        current,
        "results",
        resultCount > 0 ? "pass" : "empty",
        now,
        resultCount > 0 ? undefined : "搜索成功但返回 0 条结果"
      );
    }
    this.appendHistory(
      current,
      { success: true, zeroResult: resultCount === 0 },
      now
    );

    current.failureCount = 0;
    current.isHealthy = true;
    current.circuitState = "closed";
    current.halfOpenProbeInFlight = false;
    this.healthMap.set(pluginName, current);
  }

  recordFailure(
    pluginName: string,
    options: PluginFailureOptions = {}
  ): void {
    const current = this.healthMap.get(pluginName) || this.createStatus(pluginName);
    const wasHalfOpen = current.circuitState === "half-open";
    const now = Date.now();
    current.requestCount++;
    current.failureCount++;
    current.totalFailureCount++;
    current.lastFailureTime = now;
    current.halfOpenProbeInFlight = false;
    if (typeof options.responseTimeMs === "number") {
      this.recordResponseTime(current, options.responseTimeMs);
    }
    const category = options.errorCategory || "unknown_error";
    current.errorCounts[category] = (current.errorCounts[category] || 0) + 1;
    // 写入侧即有界：只保留计数最大的前 MAX_ERROR_CATEGORIES 项，快照体积不随分类增长。
    if (Object.keys(current.errorCounts).length > MAX_ERROR_CATEGORIES) {
      current.errorCounts = sanitizeCategoryCounts(current.errorCounts);
    }
    current.lastErrorCategory = category;
    current.lastErrorMessage = options.errorMessage;
    this.updateParsingSuccessRate(current);

    // 五维归因：按失败阶段推导各层结论；unknown 阶段不改写维度（保持上次已知状态）。
    const phase = options.phase || phaseForCategory(category);
    const message = options.errorMessage || category;
    const httpMessage = options.httpStatus
      ? `HTTP ${options.httpStatus}: ${message}`
      : message;
    switch (phase) {
      case "network":
        this.markDimensions(
          current,
          { network: "fail", http: "unknown", business: "unknown", parsing: "unknown", results: "unknown" },
          now,
          message
        );
        break;
      case "http":
        this.markDimensions(
          current,
          { network: "pass", http: "fail", business: "unknown", parsing: "unknown", results: "unknown" },
          now,
          httpMessage
        );
        break;
      case "business":
        this.markDimensions(
          current,
          { network: "pass", http: "pass", business: "fail", parsing: "unknown", results: "unknown" },
          now,
          message
        );
        break;
      case "parsing":
        this.markDimensions(
          current,
          { network: "pass", http: "pass", business: "pass", parsing: "fail", results: "unknown" },
          now,
          message
        );
        break;
      default:
        // unknown_error：失败位置不明，仅累计失败统计，不覆盖既有维度结论。
        break;
    }
    this.appendHistory(current, { success: false, zeroResult: false, category }, now);

    if (wasHalfOpen || current.failureCount >= this.config.maxFailures) {
      current.isHealthy = false;
      current.circuitState = "open";
    }
    this.healthMap.set(pluginName, current);
  }

  /**
   * Reserves permission to execute a plugin. Closed circuits allow normal
   * traffic; after cooldown an open circuit allows one half-open probe only.
   */
  canExecute(pluginName: string): boolean {
    const status = this.healthMap.get(pluginName);
    if (!status || status.circuitState === "closed") return true;

    if (status.circuitState === "half-open") {
      if (status.halfOpenProbeInFlight) return false;
      status.halfOpenProbeInFlight = true;
      this.healthMap.set(pluginName, status);
      return true;
    }

    const elapsed = status.lastFailureTime
      ? Date.now() - status.lastFailureTime
      : 0;
    if (elapsed < this.config.circuitBreakerTimeoutMs) return false;

    status.circuitState = "half-open";
    status.isHealthy = false;
    status.halfOpenProbeInFlight = true;
    this.healthMap.set(pluginName, status);
    return true;
  }

  /** A cancelled caller is not a failed recovery probe; let another request try. */
  releaseProbe(pluginName: string): void {
    const status = this.healthMap.get(pluginName);
    if (status?.circuitState === "half-open") {
      status.halfOpenProbeInFlight = false;
    }
  }

  /** Whether the circuit is fully closed. Use canExecute() for scheduling. */
  isHealthy(pluginName: string): boolean {
    return this.healthMap.get(pluginName)?.circuitState !== "open";
  }

  getStatus(pluginName: string): PluginHealthStatus | undefined {
    const status = this.healthMap.get(pluginName);
    if (!status) return undefined;
    const {
      halfOpenProbeInFlight: _probe,
      responseTimeSamples: _samples,
      ...publicStatus
    } = status;
    return {
      ...publicStatus,
      errorCounts: { ...publicStatus.errorCounts },
      dimensions: cloneDimensions(publicStatus.dimensions!),
      history: cloneHistory(publicStatus.history!),
    };
  }

  getAllStatus(): PluginHealthStatus[] {
    return [...this.healthMap.keys()]
      .map((name) => this.getStatus(name))
      .filter((status): status is PluginHealthStatus => !!status);
  }

  reset(pluginName: string): void {
    this.healthMap.delete(pluginName);
  }

  resetAll(): void {
    this.healthMap.clear();
  }

  /** Snapshot of all public status entries for persistence. */
  exportSnapshot(): Record<string, PluginHealthStatus> {
    const out: Record<string, PluginHealthStatus> = {};
    for (const name of this.healthMap.keys()) {
      const status = this.getStatus(name);
      if (status) out[name] = status;
    }
    return out;
  }

  /**
   * Seeds counters/state from a previously persisted snapshot. Latency
   * samples are not persisted, so percentiles rebuild from live traffic; an
   * "open" circuit still recovers through the normal half-open cooldown.
   * 维度状态与小时级历史趋势会一并恢复（经 sanitize 有界裁剪）。
   */
  importSnapshot(snapshot: Record<string, PluginHealthStatus>): void {
    const sanitized = sanitizePluginHealthSnapshot(snapshot || {});
    for (const [name, status] of Object.entries(sanitized)) {
      const restored: InternalPluginHealthStatus = {
        ...this.createStatus(name),
        ...status,
        name,
        errorCounts: { ...(status.errorCounts || {}) },
        dimensions: sanitizeDimensions(status.dimensions),
        history: sanitizeHistory(status.history),
        halfOpenProbeInFlight: false,
        responseTimeSamples: [],
      };
      this.healthMap.set(name, restored);
    }
  }
}

export function createPluginHealthChecker(): PluginHealthChecker {
  return new PluginHealthChecker({
    maxFailures: 5,
    circuitBreakerTimeoutMs: 5 * 60 * 1000,
    responseTimeThresholdMs: 10000,
    sampleSize: 100,
  });
}
