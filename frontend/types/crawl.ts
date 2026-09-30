import type { OutboundPolicy } from "./outbound";
import type { SearchResult } from "@/shared/apiModels";
export interface CrawlJob {
  id: number;
  channelId: string;
  kind: string;
  status: string;
  pages: number;
  messages: number;
  resources: number;
  failures: number;
  maxPages: number;
  cursorBefore: number | null;
  targetMessageId: number | null;
  lastError: string | null;
  stopReason: string | null;
  diagnostics: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}
export interface CrawlChannel {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  managed: boolean;
  archived: boolean;
  published: boolean;
  version: number;
  intervalSeconds: number;
  newestMessage: number;
  oldestMessage: number | null;
  lastSyncedAt: string | null;
  nextSyncAt: string;
  coverage: string;
  lastError: string | null;
  messageCount: number;
  resourceCount: number;
  failureCount: number;
  latestJob: CrawlJob | null;
  outbound: OutboundPolicy | null;
  effectiveOutbound: OutboundPolicy | null;
  transform?: string | null;
  bindings?: { id: string; name: string; published: boolean }[];
}
export interface CrawlMessage {
  channelId: string;
  messageId: number;
  publishedAt: string | null;
  status: string;
  parseError: string | null;
  parseVersion: string;
  summary: string;
  rawHtml?: string;
  rawText?: string;
  stored?: {
    result: SearchResult;
    enabled: boolean;
    manualOverride: boolean;
    deleted: boolean;
  }[];
}
export interface CursorPage<T> {
  items: T[];
  hasMore: boolean;
  nextCursor: string | null;
}
export interface ChannelPage {
  items: CrawlChannel[];
  total: number;
  page: number;
  pageSize: number;
}
export interface CrawlOverview {
  workerState: "online" | "offline" | "unknown";
  workerCount: number | null;
  queued: number;
  running: number;
  failed: number;
  review: number;
  serverTime: string;
}
export interface ParsePreview {
  results: SearchResult[];
  status: string;
  error: string | null;
}
export function crawlTime(value?: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? value
    : d.toLocaleString("zh-CN", { hour12: false });
}
export function crawlStatus(value: string) {
  return (
    (
      {
        queued: "排队",
        running: "执行中",
        paused: "暂停",
        failed: "失败",
        completed: "完成",
        cancelled: "已取消",
        parsed: "已解析",
        empty: "无资源",
        review: "待复核",
      } as Record<string, string>
    )[value] || value
  );
}
export function crawlKind(value: string) {
  return (
    (
      {
        sync: "增量同步",
        backfill: "历史回填",
        review: "近期编辑复查",
        reparse: "重解析原文",
        reparse_message: "单条重解析",
      } as Record<string, string>
    )[value] || value
  );
}
export function crawlReason(value?: string | null) {
  return (
    (
      {
        pending: "尚未回填",
        backfilling: "历史回填中",
        recent_window_complete: "近期编辑窗口已复查",
        checkpoint_reached: "已覆盖增量检查点",
        stored_messages_complete: "原文处理完成",
        accessible_history_end: "已到公开页面可访问边界",
        page_budget_reached: "达到本次预算",
        admin_cancelled: "管理员取消",
        channel_archived: "频道归档",
      } as Record<string, string>
    )[value || ""] ||
    value ||
    "—"
  );
}

/** Filter inputs are local wall-clock dates; API always receives an explicit UTC instant. */
export function crawlFilterDate(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
