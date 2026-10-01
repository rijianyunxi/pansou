import type { OutboundPolicy } from "./outbound";
import type { ManagedResource as SearchResult } from "@/shared/apiModels";
export interface CrawlJob {
  id: number;
  channelId: string;
  kind: string;
  status: string;
  pages: number;
  messages: number;
  resources: number;
  failures: number;
  attempts: number;
  nextRunAt: string;
  cursorBefore: number | null;
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
  version: number;
  historyComplete: boolean;
  historyCursor: number | null;
  historyPages: number;
  nextPageAt: string;
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
  workerEnabled: boolean;
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

/** Compact Shanghai wall-clock time; the full timestamp remains in the tooltip. */
export function crawlCompactTime(value?: string | null, now = Date.now()) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const parts = (d: Date) => Object.fromEntries(formatter.formatToParts(d).map(p => [p.type, p.value]));
  const time = parts(date), today = parts(new Date(now));
  const clock = `${time.hour}:${time.minute}`;
  if (time.year === today.year && time.month === today.month && time.day === today.day) return clock;
  return `${time.year === today.year ? "" : time.year + "-"}${time.month}-${time.day} ${clock}`;
}

export function compactChannelTaskLabel(channel: CrawlChannel) {
  const full = channelTaskState(channel).text;
  return ({ "历史回填中": "回填中", "增量同步中": "同步中", "失败页重试中": "重试中", "等待日常采集": "待同步", "等待历史补齐": "待回填", "等待下一页": "待续采", "等待执行": "排队中", "退避等待": "退避中", "采集中断": "已中断" } as Record<string, string>)[full] || full;
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
        retry: "失败页重试",
      } as Record<string, string>
    )[value] || value
  );
}

export type ChannelTaskState = "running" | "waiting" | "idle" | "paused" | "failed";
export function channelTaskState(channel: CrawlChannel, now = Date.now()): { state: ChannelTaskState; text: string } {
  if (!channel.enabled || channel.latestJob?.status === "paused") return { state: "paused", text: "已暂停" };
  const job = channel.latestJob;
  if (job?.status === "running") return { state: "running", text: crawlKind(job.kind) + "中" };
  if (job?.status === "failed") return { state: "failed", text: "采集中断" };
  if (job?.status === "queued") return { state: "waiting", text: job.attempts > 0 ? "退避等待" : Date.parse(job.nextRunAt) > now ? "等待下一页" : "等待执行" };
  return channel.historyComplete ? { state: "idle", text: "等待日常采集" } : { state: "waiting", text: "等待历史补齐" };
}
export function crawlReason(value?: string | null) {
  return (
    (
      {
        pending: "尚未回填",
        backfilling: "历史回填中",
        checkpoint_reached: "已覆盖增量检查点",
        accessible_history_end: "已到公开页面可访问边界",
        admin_cancelled: "管理员取消",
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

export interface CrawlSettingsValue { concurrentChannels: number; pageDelaySeconds: number; dailyIntervalSeconds: number; version: number }
export interface CrawlPageFailure { id: number; kind: string; cursorBefore: number | null; pageNumber: number | null; lastError: string; retryStatus: string | null; createdAt: string }
