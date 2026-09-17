/**
 * /monitor 运行监控页的纯视图模型。
 *
 * 监控接口只返回统一的 sources。无论资源源来自规则解析器、系统模板还是
 * Telegram 频道，前端都按同一个 ResourceSource 处理。
 */

export type MonitorKind = "source";

/** 行的归并状态：健康 / 待关注 / 异常 / 已关闭 / 已删除 / 未知。 */
export type MonitorRowState =
  | "healthy"
  | "warning"
  | "error"
  | "disabled"
  | "trashed"
  | "unknown";

/** 状态筛选：全部 / 资源源 / 异常 / 已关闭（含已删除）。 */
export type MonitorFilter = "all" | "source" | "error" | "inactive";

export interface MonitorHistoryBucket {
  t?: number | null;
  n?: number | null;
  s?: number | null;
  f?: number | null;
  z?: number | null;
  e?: Record<string, number> | null;
}

export interface MonitorDimension {
  state?: string | null;
  passRate?: number | null;
  recent?: string | number | null;
  lastMessage?: string | null;
}

export interface MonitorFailureRecord {
  at?: number | string | null;
  responseTimeMs?: number | null;
  errorCategory?: string | null;
  message?: string | null;
}

export interface MonitorSourceHealth {
  healthy?: boolean | null;
  recent?: string | null;
  circuitState?: string | null;
  requestCount?: number | null;
  successCount?: number | null;
  failureCount?: number | null;
  zeroResultCount?: number | null;
  lastSuccessAt?: number | string | null;
  lastFailureAt?: number | string | null;
  lastErrorMessage?: string | null;
  recentFailures?: MonitorFailureRecord[] | null;
  dimensions?: Record<string, MonitorDimension | null> | null;
  history?: {
    windowHours?: number | null;
    buckets?: MonitorHistoryBucket[] | null;
  } | null;
}

export interface MonitorSourceEntry {
  id?: string | null;
  name?: string | null;
  priority?: number | null;
  kind?: string | null;
  enabled?: boolean | null;
  trashed?: boolean | null;
  origin?: string | null;
  version?: string | null;
  health?: MonitorSourceHealth | null;
}

export interface MonitorData {
  generatedAt?: string | null;
  sources?: MonitorSourceEntry[] | null;
}

export type MonitorHealthSample = "success" | "failure" | "unknown";

export interface MonitorHealthStats {
  /** 只统计最近 100 次可识别的成功/失败结果。 */
  windowSize: number;
  successCount: number;
  failureCount: number;
  totalCount: number;
  successRate: number | null;
  /** 旧 → 新，用于卡片上的 20 组状态色块；未采满窗口时用 unknown 补齐。 */
  samples: MonitorHealthSample[];
  /** 每个色块代表最近 100 次中的 5 次。 */
  segments: MonitorHealthSample[];
}

export interface MonitorRow {
  /** source:<id>，用于乐观更新的定位。 */
  key: string;
  kind: MonitorKind;
  id: string;
  name: string;
  priority: number;
  typeLabel: string;
  state: MonitorRowState;
  enabled: boolean;
  trashed: boolean;
  origin: "builtin" | "custom" | "";
  version: string;
  metrics: string[];
  detail: string;
  checkedAt: string;
  checkedAtLabel: string;
  healthHealthy: boolean | null;
  failingDimension: boolean;
  recentFailures: MonitorFailureRecord[];
  health: MonitorHealthStats;
}

export interface MonitorSummary {
  total: number;
  healthy: number;
  warning: number;
  error: number;
  inactive: number;
  trashed: number;
}

export const STATE_LABELS: Record<MonitorRowState, string> = {
  healthy: "健康",
  warning: "待关注",
  error: "异常",
  disabled: "已关闭",
  trashed: "已删除",
  unknown: "未知",
};

export const STATE_TONES: Record<MonitorRowState, string> = {
  healthy: "available",
  warning: "warning",
  error: "error",
  disabled: "neutral",
  trashed: "neutral",
  unknown: "neutral",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 从接口响应中提取统一 sources。 */
export function extractMonitorData(payload: unknown): MonitorData {
  const root = asRecord(payload) ?? {};
  const data = asRecord(root.data) ?? root;
  return {
    generatedAt: text(data.generatedAt),
    sources: Array.isArray(data.sources) ? (data.sources as MonitorSourceEntry[]) : [],
  };
}

const HEALTH_WINDOW_SIZE = 100;

function sampleFromValue(value: unknown): MonitorHealthSample {
  if (value === true || value === 1 || value === "1" || value === "pass" || value === "success") return "success";
  if (value === false || value === 0 || value === "0" || value === "fail" || value === "failure") return "failure";
  // "e" 表示成功但零结果：请求本身仍然成功。
  if (value === "e" || value === "empty") return "success";
  return "unknown";
}

function samplesFromRecentString(value: unknown): MonitorHealthSample[] {
  if (typeof value !== "string") return [];
  return [...value].map(sampleFromValue).filter((sample) => sample !== "unknown");
}

function samplesFromHistory(health: MonitorSourceHealth): MonitorHealthSample[] {
  const buckets = health.history?.buckets;
  if (!Array.isArray(buckets)) return [];
  const samples: MonitorHealthSample[] = [];
  for (const bucket of buckets) {
    const success = Math.max(0, Math.floor(num(bucket?.s) ?? 0));
    const failure = Math.max(0, Math.floor(num(bucket?.f) ?? 0));
    samples.push(...Array.from({ length: success }, () => "success" as const));
    samples.push(...Array.from({ length: failure }, () => "failure" as const));
  }
  return samples.slice(-HEALTH_WINDOW_SIZE);
}

function statsFromSamples(
  samples: MonitorHealthSample[],
  fallbackSuccess = 0,
  fallbackFailure = 0,
): MonitorHealthStats {
  let normalized = samples.filter((sample) => sample !== "unknown").slice(-HEALTH_WINDOW_SIZE);
  if (!normalized.length && (fallbackSuccess > 0 || fallbackFailure > 0)) {
    const total = fallbackSuccess + fallbackFailure;
    const scale = total > HEALTH_WINDOW_SIZE ? HEALTH_WINDOW_SIZE / total : 1;
    const success = Math.min(fallbackSuccess, Math.round(fallbackSuccess * scale));
    const failure = Math.min(fallbackFailure, HEALTH_WINDOW_SIZE - success);
    normalized = [
      ...Array.from({ length: success }, () => "success" as const),
      ...Array.from({ length: failure }, () => "failure" as const),
    ];
  }
  const successCount = normalized.filter((sample) => sample === "success").length;
  const failureCount = normalized.filter((sample) => sample === "failure").length;
  const totalCount = successCount + failureCount;
  const padded = Array(HEALTH_WINDOW_SIZE - normalized.length).fill("unknown").concat(normalized);
  const segments = Array.from({ length: 20 }, (_, index) => {
    const group = padded.slice(index * 5, index * 5 + 5);
    if (group.includes("failure")) return "failure";
    if (group.includes("success")) return "success";
    return "unknown";
  });
  return {
    windowSize: HEALTH_WINDOW_SIZE,
    successCount,
    failureCount,
    totalCount,
    successRate: totalCount ? (successCount / totalCount) * 100 : null,
    samples: padded,
    segments,
  };
}

/** 统一资源源的最近 100 次成功/失败统计。 */
export function healthStats(health: MonitorSourceHealth | null | undefined): MonitorHealthStats {
  if (!health) return statsFromSamples([]);
  const recent = [
    samplesFromRecentString(health.recent),
    samplesFromRecentString(health.dimensions?.results?.recent),
    samplesFromRecentString(health.dimensions?.network?.recent),
    samplesFromHistory(health),
  ].find((candidate) => candidate.length) || [];
  return statsFromSamples(recent, num(health.successCount) ?? 0, num(health.failureCount) ?? 0);
}

function hasFailingDimension(health: MonitorSourceHealth | null | undefined): boolean {
  const dimensions = health?.dimensions;
  if (!dimensions || typeof dimensions !== "object") return false;
  return Object.values(dimensions).some((dimension) => text(dimension?.state) === "fail");
}

function toEpochMs(value: number | string | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function latestTimestamp(values: Array<number | string | null | undefined>): string {
  let latest = "";
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const ms = toEpochMs(value);
    if (ms !== null && ms > latestMs) {
      latestMs = ms;
      latest = new Date(ms).toISOString();
    }
  }
  return latest;
}

function formatClock(value: number | string | null | undefined): string {
  const ms = toEpochMs(value);
  if (ms === null) return "";
  const date = new Date(ms);
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function percent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return "—";
  const rounded = Math.round(rate * 10) / 10;
  return `${Number.isFinite(rounded) ? rounded : "—"}%`;
}

function successRateFromCounts(successCount: number | null, requestCount: number | null): string {
  if (requestCount === null || requestCount <= 0) return "—";
  return percent(((successCount ?? 0) / requestCount) * 100);
}

const CIRCUIT_LABELS: Record<string, string> = {
  closed: "正常",
  open: "已熔断",
  half_open: "半开",
  "half-open": "半开",
};

function circuitLabel(state: string): string {
  return state ? (CIRCUIT_LABELS[state.toLowerCase()] || state) : "";
}

function sourceMetrics(health: MonitorSourceHealth | null | undefined): string[] {
  if (!health) return ["暂无健康数据"];
  const metrics: string[] = [];
  const requestCount = num(health.requestCount);
  const successCount = num(health.successCount);
  if (requestCount !== null) {
    metrics.push(`请求 ${requestCount} · 成功率 ${successRateFromCounts(successCount, requestCount)}`);
  } else if (successCount !== null) {
    metrics.push(`成功 ${successCount}`);
  }
  const failureCount = num(health.failureCount);
  if (failureCount !== null && failureCount > 0) metrics.push(`失败 ${failureCount}`);
  const zeroResultCount = num(health.zeroResultCount);
  if (zeroResultCount !== null && zeroResultCount > 0) metrics.push(`零结果 ${zeroResultCount}`);
  const circuit = circuitLabel(text(health.circuitState));
  if (circuit) metrics.push(`熔断 ${circuit}`);
  return metrics.length ? metrics : ["暂无健康数据"];
}

export function resolveSourceState(entry: MonitorSourceEntry): MonitorRowState {
  if (bool(entry.trashed) === true) return "trashed";
  if (bool(entry.enabled) === false) return "disabled";
  const health = entry.health;
  if (!health) return "unknown";
  if (health.healthy === true) return hasFailingDimension(health) ? "warning" : "healthy";
  if (health.healthy === false) return "error";
  return "unknown";
}

function buildSourceRow(entry: MonitorSourceEntry): MonitorRow | null {
  const id = text(entry.id).trim();
  if (!id) return null;
  const health = entry.health ?? null;
  const state = resolveSourceState(entry);
  const origin = text(entry.origin) === "custom" ? "custom" : text(entry.origin) === "builtin" ? "builtin" : "";
  return {
    key: `source:${id}`,
    kind: "source",
    id,
    name: text(entry.name).trim() || id,
    priority: num(entry.priority) ?? 0,
    typeLabel: origin === "builtin" ? "内置资源源" : origin === "custom" ? "自定义资源源" : "资源源",
    state,
    enabled: bool(entry.enabled) !== false,
    trashed: bool(entry.trashed) === true,
    origin,
    version: text(entry.version),
    metrics: sourceMetrics(health),
    detail: text(health?.lastErrorMessage),
    checkedAt: latestTimestamp([health?.lastSuccessAt, health?.lastFailureAt]),
    checkedAtLabel: formatClock(latestTimestamp([health?.lastSuccessAt, health?.lastFailureAt])),
    healthHealthy: bool(health?.healthy),
    failingDimension: hasFailingDimension(health),
    recentFailures: Array.isArray(health?.recentFailures) ? health.recentFailures : [],
    health: healthStats(health),
  };
}

/** 将接口返回的统一资源源转换为卡片行；缺少 id 的条目会被忽略。 */
export function buildMonitorRows(data: MonitorData | null | undefined): MonitorRow[] {
  return (data?.sources ?? [])
    .map((entry) => (asRecord(entry) ? buildSourceRow(entry as MonitorSourceEntry) : null))
    .filter((row): row is MonitorRow => !!row);
}

export function summarizeRows(rows: MonitorRow[]): MonitorSummary {
  const summary: MonitorSummary = { total: 0, healthy: 0, warning: 0, error: 0, inactive: 0, trashed: 0 };
  for (const row of rows) {
    summary.total += 1;
    if (row.state === "healthy") summary.healthy += 1;
    else if (row.state === "warning") summary.warning += 1;
    else if (row.state === "error") summary.error += 1;
    else if (row.state === "disabled") summary.inactive += 1;
    else if (row.state === "trashed") summary.trashed += 1;
  }
  return summary;
}

/** 资源源 + 状态筛选 + 名称/ID/错误信息搜索；大小写不敏感。 */
export function filterRows(rows: MonitorRow[], filter: MonitorFilter, search: string): MonitorRow[] {
  const keyword = search.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter === "source" && row.kind !== "source") return false;
    if (filter === "error" && row.state !== "error") return false;
    if (filter === "inactive" && row.state !== "disabled" && row.state !== "trashed") return false;
    if (!keyword) return true;
    return `${row.name} ${row.id} ${row.detail}`.toLowerCase().includes(keyword);
  });
}

function rowStateFromFlags(row: MonitorRow): MonitorRowState {
  if (row.trashed) return "trashed";
  if (!row.enabled) return "disabled";
  if (row.healthHealthy === true) return row.failingDimension ? "warning" : "healthy";
  if (row.healthHealthy === false) return "error";
  return "unknown";
}

function patchRow(rows: MonitorRow[], key: string, patch: Partial<MonitorRow>): MonitorRow[] {
  return rows.map((row) => {
    if (row.key !== key) return row;
    const next = { ...row, ...patch };
    next.state = rowStateFromFlags(next);
    return next;
  });
}

export function withSourceEnabled(rows: MonitorRow[], id: string, enabled: boolean): MonitorRow[] {
  return patchRow(rows, `source:${id}`, { enabled });
}

export function withRowRemoved(rows: MonitorRow[], key: string): MonitorRow[] {
  return patchRow(rows, key, { trashed: true });
}

export function withRowRestored(rows: MonitorRow[], key: string): MonitorRow[] {
  return patchRow(rows, key, { trashed: false, enabled: true });
}

export function checkedAtText(row: MonitorRow): string {
  return row.checkedAtLabel || "—";
}

export function failureRecordTime(record: MonitorFailureRecord): string {
  return formatClock(record.at) || "时间未知";
}

export function failureRecordMessage(record: MonitorFailureRecord): string {
  return text(record.message) || text(record.errorCategory) || "未知错误";
}

export function relativeTime(value: number | string, now = Date.now()): string {
  const ms = toEpochMs(value);
  if (ms === null) return "—";
  const diff = Math.max(0, now - ms);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}
