import { getSqliteDatabase } from "../storage/sqlite";
import { TG_CHANNEL_PATTERN } from "../../../utils/telegramChannels";

/**
 * Telegram 频道健康存储（仿照 searchSettingsService / tgChannelSettings 的同步持久化模式）。
 *
 * 记录每个频道的最近检查结果（来源：诊断探针 probe / 正式搜索 search），
 * 供 /api/monitor 聚合展示与频道启停决策参考：
 * - 每频道最多保留最近 MAX_TG_CHANNEL_HEALTH_RECORDS 条记录；
 * - 最多跟踪 MAX_TG_CHANNEL_HEALTH_CHANNELS 个频道，超出时淘汰最久未检查的频道；
 * - SQLite namespace `tg_channel_health` 持久化；
 * - 启动后首次访问时从数据库恢复（宽松 sanitize，非法条目丢弃）；
 * - 写入路径"尽力落盘"：record 只更新内存并标记脏位，落盘由宿主的持久化
 *   节奏（SearchService 健康快照定时器）或显式 flushTgChannelHealth() 驱动，
 *   失败静默（健康数据不能影响搜索主链路）。
 */
/** 每频道保留的最近记录数。 */
export const MAX_TG_CHANNEL_HEALTH_RECORDS = 20;
/** 最多跟踪的频道数（超出淘汰最久未检查的频道）。 */
export const MAX_TG_CHANNEL_HEALTH_CHANNELS = 500;
/** 单条消息/分类在存储中保留的最大长度。 */
export const MAX_TG_CHANNEL_HEALTH_MESSAGE_LENGTH = 300;
export const MAX_TG_CHANNEL_HEALTH_KIND_LENGTH = 64;

export type TgChannelHealthSource = "probe" | "search";

/** 单次频道检查记录（持久化与 /api/monitor recent 共用同一形状）。 */
export interface TgChannelHealthRecord {
  /** 检查完成时间（epoch ms）。 */
  at: number;
  ok: boolean;
  elapsedMs: number;
  resultsCount: number;
  /** 失败（或探针零结果告警）时的机器可读分类。 */
  failureKind?: string;
  /** 面向人的原因短语。 */
  message?: string;
  source: TgChannelHealthSource;
}

export type TgChannelHealthState = "available" | "warning" | "error" | "unknown";

/** 单频道聚合视图（由最近记录推导，不单独持久化）。 */
export interface TgChannelHealthSummary {
  channel: string;
  lastCheckedAt: number | null;
  lastState: TgChannelHealthState;
  /** 最近窗口内的成功占比（ok 记录数 / 总记录数）；无记录时为 null。 */
  successRate: number | null;
  lastMessage: string;
  /** 最近一条带失败分类的记录的分类值。 */
  failureKind: string | null;
  /** 最近一条记录的耗时与结果数。 */
  elapsedMs: number | null;
  resultsCount: number | null;
  /** 最近记录（旧 → 新，最多 MAX_TG_CHANNEL_HEALTH_RECORDS 条）。 */
  recent: TgChannelHealthRecord[];
}

type StoredSnapshot = Record<string, TgChannelHealthRecord[]>;

let cached: StoredSnapshot | null = null;
let dirty = false;

function clampText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function toCount(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? Math.floor(num) : null;
}

/**
 * 由单条记录推导频道状态：
 * - 失败 → error；
 * - 成功且有结果 → available；
 * - 成功但零结果 → 探针视为 warning（"可访问但该关键词无链接"），搜索视为
 *   available（关键词无命中是正常现象，不代表频道有问题）。
 */
export function deriveTgChannelState(record: TgChannelHealthRecord): TgChannelHealthState {
  if (!record.ok) return "error";
  if (record.resultsCount > 0) return "available";
  return record.source === "probe" ? "warning" : "available";
}

/** 宽松清洗单条记录：非法字段丢弃/回退，无法修复的记录整条丢弃。 */
function sanitizeRecord(raw: unknown): TgChannelHealthRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const at = Number(input.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  if (typeof input.ok !== "boolean") return null;
  if (input.source !== "probe" && input.source !== "search") return null;
  const source: TgChannelHealthSource = input.source;
  const elapsedMs = toCount(input.elapsedMs);
  const resultsCount = toCount(input.resultsCount);
  if (elapsedMs === null || resultsCount === null) return null;
  const record: TgChannelHealthRecord = {
    at: Math.floor(at),
    ok: input.ok,
    elapsedMs,
    resultsCount,
    source,
  };
  const failureKind = clampText(input.failureKind, MAX_TG_CHANNEL_HEALTH_KIND_LENGTH);
  const message = clampText(input.message, MAX_TG_CHANNEL_HEALTH_MESSAGE_LENGTH);
  if (failureKind) record.failureKind = failureKind;
  if (message) record.message = message;
  return record;
}

/** 有界清洗整份快照：非法频道键/记录丢弃，记录按时间升序保留最近 N 条，频道总数封顶。 */
export function sanitizeTgChannelHealthSnapshot(raw: unknown): StoredSnapshot {
  const out: StoredSnapshot = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const latestAt = new Map<string, number>();
  for (const [rawKey, rawRecords] of Object.entries(raw as Record<string, unknown>)) {
    const name = String(rawKey).trim().replace(/^@/, "").toLowerCase();
    if (!TG_CHANNEL_PATTERN.test(name) || !Array.isArray(rawRecords)) continue;
    const records = (rawRecords as unknown[])
      .map(sanitizeRecord)
      .filter((record): record is TgChannelHealthRecord => record !== null)
      .sort((a, b) => a.at - b.at)
      .slice(-MAX_TG_CHANNEL_HEALTH_RECORDS);
    if (!records.length) continue;
    out[name] = records;
    latestAt.set(name, records[records.length - 1]!.at);
  }
  const keys = [...latestAt.keys()];
  if (keys.length > MAX_TG_CHANNEL_HEALTH_CHANNELS) {
    keys.sort((a, b) => (latestAt.get(a) || 0) - (latestAt.get(b) || 0));
    for (const key of keys.slice(0, keys.length - MAX_TG_CHANNEL_HEALTH_CHANNELS)) {
      delete out[key];
    }
  }
  return out;
}

function load(): StoredSnapshot {
  const rows = getSqliteDatabase().allRows<any>("SELECT channel,checked_at,ok,elapsed_ms,results_count,source,failure_kind,message FROM tg_channel_health ORDER BY channel,checked_at");
  const snapshot: StoredSnapshot = {};
  for (const row of rows) {
    (snapshot[row.channel] ||= []).push({ at: row.checked_at, ok: Boolean(row.ok), elapsedMs: row.elapsed_ms, resultsCount: row.results_count, source: row.source, ...(row.failure_kind ? { failureKind: row.failure_kind } : {}), ...(row.message ? { message: row.message } : {}) });
  }
  return sanitizeTgChannelHealthSnapshot(snapshot);
}

function getStore(): StoredSnapshot {
  if (cached === null) cached = load();
  return cached;
}

export function flushTgChannelHealth(): boolean {
  if (!dirty) return true;
  try {
    const db = getSqliteDatabase();
    db.transaction(() => {
      db.run("DELETE FROM tg_channel_health");
      for (const [channel, records] of Object.entries(cached || {})) for (const record of records) db.run("INSERT OR IGNORE INTO tg_channel_health(channel,checked_at,ok,elapsed_ms,results_count,source,failure_kind,message) VALUES(?,?,?,?,?,?,?,?)", channel, record.at, record.ok ? 1 : 0, record.elapsedMs, record.resultsCount, record.source, record.failureKind || null, record.message || null);
    });
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

export function recordTgChannelHealth(entry: {
  channel: string;
  at?: number;
  ok: boolean;
  elapsedMs: number;
  resultsCount: number;
  failureKind?: string;
  message?: string;
  source: TgChannelHealthSource;
}): void {
  const name = (entry.channel || "").trim().replace(/^@/, "").toLowerCase();
  if (!TG_CHANNEL_PATTERN.test(name) || typeof entry.ok !== "boolean") return;
  const at = Number.isFinite(entry.at) && (entry.at as number) > 0 ? Math.floor(entry.at as number) : Date.now();
  const elapsedMs = toCount(entry.elapsedMs) ?? 0;
  const resultsCount = toCount(entry.resultsCount) ?? 0;
  const record: TgChannelHealthRecord = { at, ok: entry.ok, elapsedMs, resultsCount, source: entry.source };
  const failureKind = clampText(entry.failureKind, MAX_TG_CHANNEL_HEALTH_KIND_LENGTH);
  const message = clampText(entry.message, MAX_TG_CHANNEL_HEALTH_MESSAGE_LENGTH);
  if (failureKind) record.failureKind = failureKind;
  if (message) record.message = message;

  const store = getStore();
  const records = [...(store[name] || []), record].slice(-MAX_TG_CHANNEL_HEALTH_RECORDS);
  const next: StoredSnapshot = { ...store, [name]: records };
  const keys = Object.keys(next);
  if (keys.length > MAX_TG_CHANNEL_HEALTH_CHANNELS) {
    keys.sort((a, b) => {
      const left = next[a]![next[a]!.length - 1]!.at;
      const right = next[b]![next[b]!.length - 1]!.at;
      return left - right;
    });
    for (const key of keys.slice(0, keys.length - MAX_TG_CHANNEL_HEALTH_CHANNELS)) {
      delete next[key];
    }
  }
  cached = next;
  dirty = true;
  // Health is non-critical, but SQLite keeps the latest state durable without
  // making the search path fail if a write is temporarily unavailable.
  flushTgChannelHealth();
}

/** 单频道聚合视图；该频道没有任何记录时返回 null。 */
export function getTgChannelHealthSummary(channel: string): TgChannelHealthSummary | null {
  const name = (channel || "").trim().replace(/^@/, "").toLowerCase();
  return summarize(name, getStore()[name]);
}

/** 全部频道的聚合视图（/api/monitor 用）。 */
export function getAllTgChannelHealthSummaries(): Record<string, TgChannelHealthSummary> {
  const store = getStore();
  const out: Record<string, TgChannelHealthSummary> = {};
  for (const [name, records] of Object.entries(store)) {
    const summary = summarize(name, records);
    if (summary) out[name] = summary;
  }
  return out;
}

function summarize(channel: string, records: TgChannelHealthRecord[] | undefined): TgChannelHealthSummary | null {
  if (!records || !records.length) return null;
  const last = records[records.length - 1]!;
  let failureKind: string | null = null;
  for (let index = records.length - 1; index >= 0; index--) {
    const kind = records[index]!.failureKind;
    if (kind) {
      failureKind = kind;
      break;
    }
  }
  const okCount = records.filter((record) => record.ok).length;
  return {
    channel,
    lastCheckedAt: last.at,
    lastState: deriveTgChannelState(last),
    successRate: okCount / records.length,
    lastMessage: last.message || "",
    failureKind,
    elapsedMs: last.elapsedMs,
    resultsCount: last.resultsCount,
    recent: records.map((record) => ({ ...record })),
  };
}
