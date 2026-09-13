/**
 * TG 频道健康监控（GET /api/monitor）与频道覆盖状态（停用/删除）的前端视图工具：
 * - 归一化后端返回的频道健康摘要与 enabled/deleted 覆盖状态；
 * - 生成频道目录行内的健康摘要文案；
 * - 后端未就绪、404 或字段缺省时安全兜底（UI 显示"未检测"/"启用"），绝不抛错。
 * 仅供管理端诊断 UI 使用，不包含服务端逻辑。
 */
import { failureKindLabel } from "./telegramProbeView";

export type TgOverrideOrigin = "builtin" | "custom";

/** GET /api/monitor data.channels[] 的单频道条目（字段均可缺省）。 */
export interface TgMonitorChannel {
  channel?: string;
  origin?: string;
  enabled?: boolean;
  deleted?: boolean;
  policy?: unknown;
  health?: TgMonitorHealth | null;
}

export interface TgMonitorHealth {
  state?: string;
  failureKind?: string;
  lastCheckedAt?: string;
  elapsedMs?: number;
  resultsCount?: number;
  message?: string;
  successRate?: number;
  recent?: unknown[];
}

/** disable/enable/delete 动作的响应 data（字段均可缺省）。 */
export interface TgChannelOverridePayload {
  channel?: string;
  enabled?: boolean;
  deleted?: boolean;
  origin?: string;
  effectiveCount?: number | string;
}

export interface TgChannelOverride {
  enabled: boolean;
  deleted: boolean;
  origin: TgOverrideOrigin;
  effectiveCount: number | null;
}

export type TgHealthTone = "ok" | "warn" | "bad" | "neutral";

export function normalizeTgOrigin(origin?: string | null, fallback: TgOverrideOrigin = "custom"): TgOverrideOrigin {
  return origin === "builtin" || origin === "custom" ? origin : fallback;
}

/**
 * 归一化启停/删除覆盖：缺省 enabled 视为启用、缺省 deleted 视为未删除，
 * effectiveCount 仅接受有限数值（含数字字符串），其余返回 null。
 */
export function normalizeTgOverride(data?: TgChannelOverridePayload | null): TgChannelOverride {
  if (!data || typeof data !== "object") return { enabled: true, deleted: false, origin: "custom", effectiveCount: null };
  const rawCount = data.effectiveCount;
  const count = typeof rawCount === "number"
    ? rawCount
    : typeof rawCount === "string" && rawCount.trim()
      ? Number(rawCount)
      : NaN;
  return {
    enabled: data.enabled !== false,
    deleted: data.deleted === true,
    origin: normalizeTgOrigin(data.origin),
    effectiveCount: Number.isFinite(count) ? count : null,
  };
}

const STATE_LABELS: Record<string, string> = {
  available: "可提取结果",
  ok: "可提取结果",
  healthy: "可提取结果",
  success: "可提取结果",
  warning: "需确认",
  warn: "需确认",
  degraded: "需确认",
  error: "请求异常",
  failed: "请求异常",
  fail: "请求异常",
  unhealthy: "请求异常",
};

/** 健康状态的可读文案；未知状态原样返回，空值返回空串。 */
export function tgMonitorStateLabel(state?: string | null): string {
  if (typeof state !== "string") return "";
  const key = state.trim().toLowerCase();
  if (!key) return "";
  return STATE_LABELS[key] ?? state.trim();
}

export function tgMonitorStateTone(state?: string | null): TgHealthTone {
  const key = typeof state === "string" ? state.trim().toLowerCase() : "";
  if (["available", "ok", "healthy", "success"].includes(key)) return "ok";
  if (["warning", "warn", "degraded"].includes(key)) return "warn";
  if (["error", "failed", "fail", "unhealthy"].includes(key)) return "bad";
  return "neutral";
}

export interface TgMonitorHealthSummary {
  /** 行内单行摘要，如 "可提取结果 · 123 ms · 5 条"。 */
  line: string;
  /** 次要说明：失败分类文案或服务端 message。 */
  detail: string;
  tone: TgHealthTone;
}

/**
 * 把 /api/monitor 的 health 字段转成行内摘要。
 * 缺失的数值段自动跳过；完全没有可展示内容时返回 null（UI 显示"未检测"）。
 */
export function describeTgMonitorHealth(health?: TgMonitorHealth | null): TgMonitorHealthSummary | null {
  if (!health || typeof health !== "object") return null;
  const parts: string[] = [];
  const label = tgMonitorStateLabel(health.state);
  if (label) parts.push(label);
  const elapsed = health.elapsedMs == null ? NaN : Number(health.elapsedMs);
  if (Number.isFinite(elapsed) && elapsed >= 0) parts.push(`${Math.round(elapsed)} ms`);
  const count = health.resultsCount == null ? NaN : Number(health.resultsCount);
  if (Number.isFinite(count) && count >= 0) parts.push(`${Math.round(count)} 条`);
  const message = typeof health.message === "string" ? health.message.trim() : "";
  if (!parts.length && !message) return null;
  const line = parts.length ? parts.join(" · ") : message || "已检测";
  const detail = failureKindLabel(health.failureKind) || message;
  return { line, detail, tone: tgMonitorStateTone(health.state) };
}
