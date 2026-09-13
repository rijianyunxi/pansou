import type {
  PluginHealthHourlyBucket,
  PluginHealthStatus,
} from "../../server/core/plugins/pluginHealth";

/**
 * 服务端健康面板的纯视图模型：把 /api/plugin-health 的五维状态、
 * 小时级趋势桶与失败分类计数转换为可渲染的行数据。
 * 保持无副作用，便于 Vitest 直接覆盖。
 * 响应载荷类型由监控接口直接提供。
 */

export type ServerHealthDimensionKey =
  | "network"
  | "http"
  | "business"
  | "parsing"
  | "results";

export const SERVER_DIMENSIONS: {
  key: ServerHealthDimensionKey;
  label: string;
}[] = [
  { key: "network", label: "网络可达" },
  { key: "http", label: "HTTP 正常" },
  { key: "business", label: "业务状态" },
  { key: "parsing", label: "结构解析" },
  { key: "results", label: "搜索结果" },
];

export const FAILURE_CATEGORY_LABELS: Record<string, string> = {
  network_error: "网络失败",
  timeout_error: "请求超时",
  http_error: "HTTP 错误",
  parse_error: "解析失败",
  validation_error: "业务校验失败",
  business_error: "业务状态异常",
  plugin_error: "插件内部错误",
  unknown_error: "未知错误",
  other: "其他",
};

export const CIRCUIT_STATE_LABELS: Record<string, string> = {
  closed: "正常",
  open: "已熔断",
  "half-open": "半开探测",
};

export interface ServerHealthTrendRow {
  t: number;
  hourLabel: string;
  /** 柱高（0-100，按桶内检查总数归一化）。 */
  height: number;
  /** 三段占比（约 100）：成功 / 零结果 / 失败。 */
  successPct: number;
  zeroPct: number;
  title: string;
}

export interface ServerHealthFailureRow {
  category: string;
  label: string;
  count: number;
  /** 条形宽度（0-100，按最大计数归一化）。 */
  width: number;
}

export interface ServerHealthDimensionRow {
  key: ServerHealthDimensionKey;
  label: string;
  state: string;
  rate: string;
  message: string;
}

export interface ServerHealthOverviewSummary {
  healthy: number;
  total: number;
  checks: number;
  failures: number;
  zeroResults: number;
}

function hourLabelOf(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:00`;
}

/** 每小时趋势柱：高度按最大桶归一，三段分别为成功/零结果/失败占比。 */
export function buildTrendRows(
  buckets: PluginHealthHourlyBucket[]
): ServerHealthTrendRow[] {
  if (!buckets.length) return [];
  const maxTotal = Math.max(...buckets.map((bucket) => bucket.n)) || 1;
  return buckets.map((bucket) => {
    const hourLabel = hourLabelOf(bucket.t);
    const successPct = bucket.n ? Math.round((bucket.s / bucket.n) * 100) : 0;
    const zeroPct = bucket.n ? Math.round((bucket.z / bucket.n) * 100) : 0;
    return {
      t: bucket.t,
      hourLabel,
      height: Math.max(10, Math.round((bucket.n / maxTotal) * 100)),
      successPct,
      zeroPct,
      title:
        `${hourLabel} · 检查 ${bucket.n} · 成功 ${bucket.s} · 失败 ${bucket.f}` +
        (bucket.z ? ` · 零结果 ${bucket.z}` : ""),
    };
  });
}

/**
 * 失败原因分布：优先聚合趋势桶内的分类计数；没有任何桶时回退到
 * 累计 errorCounts（旧快照或刚启动的场景）。只展示前 6 项。
 */
export function buildFailureRows(
  buckets: PluginHealthHourlyBucket[],
  fallbackCounts: Record<string, number> = {}
): ServerHealthFailureRow[] {
  const counts: Record<string, number> = {};
  for (const bucket of buckets) {
    for (const [category, count] of Object.entries(bucket.e ?? {})) {
      counts[category] = (counts[category] || 0) + count;
    }
  }
  if (!Object.keys(counts).length) {
    for (const [category, count] of Object.entries(fallbackCounts)) {
      if (count > 0) counts[category] = count;
    }
  }
  const max = Math.max(0, ...Object.values(counts)) || 1;
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([category, count]) => ({
      category,
      label: FAILURE_CATEGORY_LABELS[category] || category,
      count,
      width: Math.max(6, Math.round((count / max) * 100)),
    }));
}

/** 五维状态行：pass/fail/empty/unknown + 有界窗口通过率。 */
export function buildDimensionRows(
  status?: PluginHealthStatus
): ServerHealthDimensionRow[] {
  if (!status) return [];
  return SERVER_DIMENSIONS.map(({ key, label }) => {
    const dim = status.dimensions?.[key];
    const total = dim ? dim.passCount + dim.failCount + dim.emptyCount : 0;
    return {
      key,
      label,
      state: dim?.state ?? "unknown",
      rate: total ? `${Math.round((dim!.passCount / total) * 100)}%` : "—",
      message: dim?.lastMessage || "",
    };
  });
}

/** 概览汇总：健康数 + 趋势窗口内的检查/失败/零结果总数。 */
export function buildOverviewSummary(
  payload: {
    healthy: number;
    total: number;
    trend?: { windowHours?: number; buckets?: PluginHealthHourlyBucket[] } | null;
  } | null
): ServerHealthOverviewSummary | null {
  if (!payload) return null;
  let checks = 0;
  let failures = 0;
  let zeroResults = 0;
  for (const bucket of payload.trend?.buckets ?? []) {
    checks += bucket.n;
    failures += bucket.f;
    zeroResults += bucket.z;
  }
  return {
    healthy: payload.healthy,
    total: payload.total,
    checks,
    failures,
    zeroResults,
  };
}

export function circuitLabel(state?: string): string {
  return CIRCUIT_STATE_LABELS[state || ""] || state || "未知";
}
