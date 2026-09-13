/**
 * /monitor 健康监控页的纯视图模型。
 *
 * 后端契约（GET /api/monitor）尚未完全落地：这里对每个字段都做缺省兜底，
 * 任何 null / undefined / 类型不符的输入都不应抛错，而是回退为"未知"状态。
 * 不依赖 Vue 运行时，方便 Vitest 直接单测。
 */

export type MonitorKind = "upstream" | "channel";

/** 行的归并状态：健康 / 待关注 / 异常 / 已停用 / 已删除 / 未知。 */
export type MonitorRowState =
  | "healthy"
  | "warning"
  | "error"
  | "disabled"
  | "trashed"
  | "unknown";

/** 类型筛选：全部 / 上游 / TG 频道 / 异常 / 已停用（含已删除）。 */
export type MonitorFilter = "all" | "upstream" | "channel" | "error" | "inactive";

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
  recent?: number | null;
  lastMessage?: string | null;
}

export interface MonitorUpstreamHealth {
  healthy?: boolean | null;
  circuitState?: string | null;
  requestCount?: number | null;
  successCount?: number | null;
  failureCount?: number | null;
  zeroResultCount?: number | null;
  /** 后端契约为 epoch 毫秒 number；兼容 ISO 字符串以便测试与旧数据。 */
  lastSuccessAt?: number | string | null;
  lastFailureAt?: number | string | null;
  lastErrorMessage?: string | null;
  dimensions?: Record<string, MonitorDimension | null> | null;
  history?: {
    windowHours?: number | null;
    buckets?: MonitorHistoryBucket[] | null;
  } | null;
}

export interface MonitorChannelSample {
  at?: number | string | null;
  ok?: boolean | null;
  elapsedMs?: number | null;
  resultsCount?: number | null;
  failureKind?: string | null;
  source?: string | null;
}

export interface MonitorChannelHealth {
  state?: string | null;
  failureKind?: string | null;
  lastCheckedAt?: number | string | null;
  elapsedMs?: number | null;
  resultsCount?: number | null;
  message?: string | null;
  successRate?: number | null;
  recent?: MonitorChannelSample[] | null;
}

export interface MonitorUpstreamEntry {
  id?: string | null;
  name?: string | null;
  kind?: string | null;
  enabled?: boolean | null;
  trashed?: boolean | null;
  version?: string | null;
  health?: MonitorUpstreamHealth | null;
}

export interface MonitorChannelEntry {
  channel?: string | null;
  origin?: string | null;
  enabled?: boolean | null;
  deleted?: boolean | null;
  policy?: unknown;
  health?: MonitorChannelHealth | null;
}

export interface MonitorData {
  generatedAt?: string | null;
  upstreams?: MonitorUpstreamEntry[] | null;
  channels?: MonitorChannelEntry[] | null;
}

export interface MonitorRow {
  /** upstream:<id> / channel:<name>，用于乐观更新的定位。 */
  key: string;
  kind: MonitorKind;
  /** 上游 id 或频道名（不含 @）。 */
  id: string;
  name: string;
  typeLabel: string;
  state: MonitorRowState;
  enabled: boolean;
  trashed: boolean;
  origin: "builtin" | "custom" | "";
  /** 上游插件类型：code=Core 配置来源，instructions=页面发布的规则插件。决定删除语义。 */
  upstreamKind: "code" | "instructions" | "";
  version: string;
  metrics: string[];
  detail: string;
  checkedAt: string;
  checkedAtLabel: string;
  /** 乐观启停时用于重算状态：health.healthy 原始值。 */
  healthHealthy: boolean | null;
  /** 乐观启停时用于重算状态：上游存在未通过的五维检查。 */
  failingDimension: boolean;
  /** 乐观启停时用于重算状态：频道 health.state 原始值。 */
  healthState: string;
}

export interface MonitorKindSummary {
  total: number;
  healthy: number;
  warning: number;
  error: number;
  inactive: number;
  trashed: number;
}

export interface MonitorSummary {
  total: number;
  healthy: number;
  warning: number;
  error: number;
  inactive: number;
  trashed: number;
  upstreams: MonitorKindSummary;
  channels: MonitorKindSummary;
}

export const STATE_LABELS: Record<MonitorRowState, string> = {
  healthy: "健康",
  warning: "待关注",
  error: "异常",
  disabled: "已停用",
  trashed: "已删除",
  unknown: "未知",
};

/** 复用 upstream-console.css 的 state-badge / status-dot 色系。 */
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

/** 从任意响应形态中提取 { generatedAt, upstreams, channels }，全部缺省兜底。 */
export function extractMonitorData(payload: unknown): MonitorData {
  const root = asRecord(payload) ?? {};
  const data = asRecord(root.data) ?? root;
  return {
    generatedAt: text(data.generatedAt),
    upstreams: Array.isArray(data.upstreams) ? (data.upstreams as MonitorUpstreamEntry[]) : [],
    channels: Array.isArray(data.channels) ? (data.channels as MonitorChannelEntry[]) : [],
  };
}

function hasFailingDimension(health: MonitorUpstreamHealth | null | undefined): boolean {
  const dimensions = health?.dimensions;
  if (!dimensions || typeof dimensions !== "object") return false;
  return Object.values(dimensions).some(
    (dimension) => text(dimension?.state) === "fail",
  );
}

/** 时间戳归一：epoch 毫秒 number 直接使用，字符串走 Date.parse；不可解析返回 null。 */
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

function successRateFromCounts(
  successCount: number | null,
  requestCount: number | null,
): string {
  if (requestCount === null || requestCount <= 0) return "—";
  return percent(((successCount ?? 0) / requestCount) * 100);
}

const CIRCUIT_LABELS: Record<string, string> = {
  closed: "正常",
  open: "已熔断",
  half_open: "半开",
  "half-open": "半开",
};

export function circuitLabel(state: string): string {
  if (!state) return "";
  return CIRCUIT_LABELS[state.toLowerCase()] || state;
}

const CHANNEL_STATE_LABELS: Record<string, string> = {
  available: "可用",
  warning: "告警",
  error: "异常",
  unknown: "未知",
};

export function channelHealthLabel(state: string): string {
  if (!state) return "";
  return CHANNEL_STATE_LABELS[state] || state;
}

export function upstreamMetrics(health: MonitorUpstreamHealth | null | undefined): string[] {
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

export function channelMetrics(health: MonitorChannelHealth | null | undefined): string[] {
  if (!health) return ["暂无检测数据"];
  const metrics: string[] = [];
  const stateLabel = channelHealthLabel(text(health.state));
  if (stateLabel) metrics.push(`状态 ${stateLabel}`);
  const elapsedMs = num(health.elapsedMs);
  const resultsCount = num(health.resultsCount);
  if (elapsedMs !== null || resultsCount !== null) {
    metrics.push(`${elapsedMs === null ? "—" : `${elapsedMs} ms`} · 结果 ${resultsCount ?? "—"}`);
  }
  const successRate = num(health.successRate);
  if (successRate !== null) metrics.push(`成功率 ${percent(successRate)}`);
  const failureKind = text(health.failureKind);
  if (failureKind) metrics.push(`失败分类 ${failureKind}`);
  return metrics.length ? metrics : ["暂无检测数据"];
}

export function resolveUpstreamState(entry: MonitorUpstreamEntry): MonitorRowState {
  if (bool(entry.trashed) === true) return "trashed";
  if (bool(entry.enabled) === false) return "disabled";
  const health = entry.health;
  if (!health) return "unknown";
  if (health.healthy === true) return hasFailingDimension(health) ? "warning" : "healthy";
  if (health.healthy === false) return "error";
  return "unknown";
}

export function resolveChannelState(entry: MonitorChannelEntry): MonitorRowState {
  if (bool(entry.deleted) === true) return "trashed";
  if (bool(entry.enabled) === false) return "disabled";
  const state = text(entry.health?.state);
  if (state === "available") return "healthy";
  if (state === "warning") return "warning";
  if (state === "error") return "error";
  return "unknown";
}

function buildUpstreamRow(entry: MonitorUpstreamEntry): MonitorRow | null {
  const id = text(entry.id).trim();
  if (!id) return null;
  const health = entry.health ?? null;
  const state = resolveUpstreamState(entry);
  return {
    key: `upstream:${id}`,
    kind: "upstream",
    id,
    name: text(entry.name).trim() || id,
    typeLabel: text(entry.kind) === "instructions" ? "规则插件" : "代码插件",
    state,
    enabled: bool(entry.enabled) !== false,
    trashed: bool(entry.trashed) === true,
    origin: "",
    upstreamKind: text(entry.kind) === "instructions" ? "instructions" : "code",
    version: text(entry.version),
    metrics: upstreamMetrics(health),
    detail: text(health?.lastErrorMessage),
    checkedAt: latestTimestamp([health?.lastSuccessAt, health?.lastFailureAt]),
    checkedAtLabel: formatClock(latestTimestamp([health?.lastSuccessAt, health?.lastFailureAt])),
    healthHealthy: bool(health?.healthy),
    failingDimension: hasFailingDimension(health),
    healthState: "",
  };
}

function buildChannelRow(entry: MonitorChannelEntry): MonitorRow | null {
  const id = text(entry.channel).trim().replace(/^@/, "");
  if (!id) return null;
  const health = entry.health ?? null;
  const state = resolveChannelState(entry);
  return {
    key: `channel:${id}`,
    kind: "channel",
    id,
    name: `@${id}`,
    typeLabel: text(entry.origin) === "custom" ? "手动频道" : "已配置频道",
    state,
    enabled: bool(entry.enabled) !== false,
    trashed: bool(entry.deleted) === true,
    origin: text(entry.origin) === "custom" ? "custom" : "builtin",
    upstreamKind: "",
    version: "",
    metrics: channelMetrics(health),
    detail: text(health?.message) || text(health?.failureKind),
    checkedAt: text(health?.lastCheckedAt),
    checkedAtLabel: formatClock(health?.lastCheckedAt),
    healthHealthy: null,
    failingDimension: false,
    healthState: text(health?.state),
  };
}

/** 合并上游与频道为统一行列表；非法条目（缺 id）被忽略。 */
export function buildMonitorRows(data: MonitorData | null | undefined): MonitorRow[] {
  const rows: MonitorRow[] = [];
  for (const entry of data?.upstreams ?? []) {
    const row = asRecord(entry) ? buildUpstreamRow(entry as MonitorUpstreamEntry) : null;
    if (row) rows.push(row);
  }
  for (const entry of data?.channels ?? []) {
    const row = asRecord(entry) ? buildChannelRow(entry as MonitorChannelEntry) : null;
    if (row) rows.push(row);
  }
  return rows;
}

function emptyKindSummary(): MonitorKindSummary {
  return { total: 0, healthy: 0, warning: 0, error: 0, inactive: 0, trashed: 0 };
}

function accumulate(kind: MonitorKindSummary, state: MonitorRowState) {
  kind.total += 1;
  if (state === "healthy") kind.healthy += 1;
  else if (state === "warning") kind.warning += 1;
  else if (state === "error") kind.error += 1;
  else if (state === "disabled") kind.inactive += 1;
  else if (state === "trashed") kind.trashed += 1;
}

/** 汇总卡片：总数 / 健康 / 待关注 / 异常 / 已停用，上游与频道分开计数。 */
export function summarizeRows(rows: MonitorRow[]): MonitorSummary {
  const summary: MonitorSummary = {
    total: 0,
    healthy: 0,
    warning: 0,
    error: 0,
    inactive: 0,
    trashed: 0,
    upstreams: emptyKindSummary(),
    channels: emptyKindSummary(),
  };
  for (const row of rows) {
    const kind = row.kind === "upstream" ? summary.upstreams : summary.channels;
    accumulate(kind, row.state);
    summary.total += 1;
    if (row.state === "healthy") summary.healthy += 1;
    else if (row.state === "warning") summary.warning += 1;
    else if (row.state === "error") summary.error += 1;
    else if (row.state === "disabled") summary.inactive += 1;
    else if (row.state === "trashed") summary.trashed += 1;
  }
  return summary;
}

/** 类型筛选 + 名称/ID/错误信息搜索；大小写不敏感。 */
export function filterRows(rows: MonitorRow[], filter: MonitorFilter, search: string): MonitorRow[] {
  const keyword = search.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter === "upstream" && row.kind !== "upstream") return false;
    if (filter === "channel" && row.kind !== "channel") return false;
    if (filter === "error" && row.state !== "error") return false;
    if (filter === "inactive" && row.state !== "disabled" && row.state !== "trashed") return false;
    if (!keyword) return true;
    return `${row.name} ${row.id} ${row.detail}`.toLowerCase().includes(keyword);
  });
}

function rowStateFromFlags(row: MonitorRow): MonitorRowState {
  if (row.trashed) return "trashed";
  if (!row.enabled) return "disabled";
  if (row.kind === "upstream") {
    if (row.healthHealthy === true) return row.failingDimension ? "warning" : "healthy";
    if (row.healthHealthy === false) return "error";
    return "unknown";
  }
  if (row.healthState === "available") return "healthy";
  if (row.healthState === "warning") return "warning";
  if (row.healthState === "error") return "error";
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

/** 乐观更新：切换上游启停后重算行状态；失败时页面用快照回滚。 */
export function withUpstreamEnabled(rows: MonitorRow[], id: string, enabled: boolean): MonitorRow[] {
  return patchRow(rows, `upstream:${id}`, { enabled });
}

/** 乐观更新：切换频道启停后重算行状态；失败时页面用快照回滚。 */
export function withChannelEnabled(rows: MonitorRow[], channel: string, enabled: boolean): MonitorRow[] {
  return patchRow(rows, `channel:${channel}`, { enabled });
}

/** 乐观更新：标记对象已删除（上游进入垃圾箱语义 / 频道移出生效清单）。 */
export function withRowRemoved(rows: MonitorRow[], key: string): MonitorRow[] {
  return patchRow(rows, key, { trashed: true });
}

/** 乐观更新：恢复对象（垃圾箱恢复 / 已删除频道重新启用参与搜索）。 */
export function withRowRestored(rows: MonitorRow[], key: string): MonitorRow[] {
  return patchRow(rows, key, { trashed: false, enabled: true });
}

/** 最近检查时间展示；缺省或不可解析时返回 "—"。 */
export function checkedAtText(row: MonitorRow): string {
  return row.checkedAtLabel || "—";
}

/** 相对时间辅助（汇总卡副文案用），缺省兜底 "—"；接受 epoch 毫秒或 ISO 字符串。 */
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
