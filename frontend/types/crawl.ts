import type { OutboundPolicy } from "./outbound";
import type { ManagedResource as SearchResult } from "@/shared/apiModels";
interface CrawlJob {
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
  failedMessageCount: number;
  resourceCount: number;
  latestJob: CrawlJob | null;
  taskState?: 'running' | 'queued' | 'backoff' | 'idle' | 'paused' | 'failed';
  taskPhase?: 'fetching' | 'page_wait' | 'ready' | 'backoff' | 'queued' | 'paused' | null;
  taskStateAt?: string;
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
  stored?: {
    result: SearchResult;
    enabled: boolean;
    manualOverride: boolean;
    deleted: boolean;
  }[];
}
interface MessageCounts {
  all: number;
  parsed: number;
  empty: number;
  failed: number;
}
export interface MessagePage {
  items: CrawlMessage[];
  total: number;
  page: number;
  pageSize: number;
  counts: MessageCounts;
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
  backoff: number;
  fetching: number;
  scheduling?: { concurrentChannels: number; pageDelaySeconds: number };
  running: number;
  failed: number;
  review: number;
  serverTime: string;
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
  const state = channelTaskState(channel).state;
  if (state === 'running') return '采集中';
  if (channel.taskState === 'backoff') return '退避中';
  if (channel.taskState === 'queued' || channel.latestJob?.status === 'queued' && state !== 'paused') return '排队中';
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
function crawlKind(value: string) {
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

type ChannelTaskState = "running" | "waiting" | "idle" | "paused" | "failed";
export function channelTaskState(channel: CrawlChannel, now = Date.now()): { state: ChannelTaskState; text: string } {
  if (channel.taskState) {
    if (channel.taskState === 'paused') return { state: 'paused', text: '已暂停' };
    if (channel.taskState === 'running') {
      const phase = channel.taskPhase === 'page_wait' ? '等待下一页' : channel.taskPhase === 'ready' ? '等待调度' : '正在处理页面';
      return { state: 'running', text: crawlKind(channel.latestJob?.kind || '') + '中 · ' + phase };
    }
    if (channel.taskState === 'backoff') return { state: 'waiting', text: '退避等待' };
    if (channel.taskState === 'failed') return { state: 'failed', text: '采集中断' };
    if (channel.taskState === 'queued') {
      return { state: 'waiting', text: '等待并发槽位' };
    }
    return channel.historyComplete ? { state: 'idle', text: '等待日常采集' } : { state: 'waiting', text: '等待历史补齐' };
  }
  if (!channel.enabled || channel.latestJob?.status === "paused") return { state: "paused", text: "已暂停" };
  const job = channel.latestJob;
  if (job?.status === "running") return { state: "running", text: crawlKind(job.kind) + "中" };
  if (job?.status === "failed") return { state: "failed", text: "采集中断" };
  if (job?.status === "queued") return { state: "waiting", text: job.attempts > 0 ? "退避等待" : Date.parse(job.nextRunAt) > now ? "等待下一页" : "等待执行" };
  return channel.historyComplete ? { state: "idle", text: "等待日常采集" } : { state: "waiting", text: "等待历史补齐" };
}

/** Filter inputs are local wall-clock dates; API always receives an explicit UTC instant. */
export function crawlFilterDate(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export interface CrawlSettingsValue { concurrentChannels: number; pageDelaySeconds: number; dailyIntervalSeconds: number; version: number }
