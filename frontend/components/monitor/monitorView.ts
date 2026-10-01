export type RuntimeState = 'online' | 'offline' | 'unknown' | 'unavailable';
export interface WorkerStatus { state: RuntimeState; count: number | null; enabled: boolean }
export interface QueueCounts { queued: number; running: number; failed: number; completed: number; blocked?: number }
export interface LiveSource {
  id: string; name: string; enabled: boolean;
  health: null | {
    healthy?: boolean; circuitState?: string; requestCount?: number; successCount?: number;
    totalFailureCount?: number; zeroResultCount?: number; avgResponseTime?: number;
    lastSuccessAt?: string | number; lastFailureAt?: string | number; lastErrorMessage?: string;
  };
}
export interface MonitorData {
  generatedAt: string;
  services: {
    api: { state: RuntimeState; startedAt: string };
    postgres: { state: RuntimeState; connections: number; idle: number };
    redis: { state: RuntimeState };
  };
  workers: { crawl: WorkerStatus; links: WorkerStatus };
  crawl: {
    queued: number; ready: number; running: number; failed: number; paused: number; expired: number;
    channels: number; activeChannels: number; overdueChannels: number; review: number; resources: number;
    lastActivityAt: string | null; lastSyncAt: string | null;
    recentFailures: Array<{ channel: string; kind: string; error: string | null; at: string }>;
  };
  links: {
    syncPending: number; oldestSyncAt: string | null; catalog: number; valid: number; invalid: number; errors: number;
    queues: { checks: QueueCounts; cleanup: QueueCounts; resolve: QueueCounts };
    cleanupDue: number; checksEnabled: boolean; deliveryEnabled: { baidu: boolean; quark: boolean };
    deliveryStats?: { processing: number; transferred: number; reused: number; fallback: number; direct: number; unavailable: number };
    checkHealth?: { due: number; failing: number; unknown: number; stuckJobs: number };
    recentCheckFailures?: Array<{
      provider: string; identity: string | null; validity: number; failureCount: number;
      lastErrorCode: string | null; lastAttemptAt: string | null; nextCheckAt: string | null;
    }>;
    recentCleanup?: Array<{
      status: string; stage: string | null; lastErrorCode: string | null; attempts: number;
      provider: string | null; updatedAt: string;
    }>;
  };
  sources: LiveSource[];
}
export function workerLabel(worker: WorkerStatus): string {
  if (worker.state === 'unknown' || worker.state === 'unavailable') return '状态不可用';
  if (worker.state === 'offline') return '未检测到在线 Worker';
  return worker.enabled ? '运行中' : '已暂停调度';
}
export function sourceLabel(source: LiveSource): string {
  if (!source.enabled) return '已停用';
  if (!source.health || !source.health.requestCount) return '暂无请求记录';
  if (source.health.circuitState === 'open') return '已熔断';
  return source.health.healthy === true ? '最近请求成功' : source.health.healthy === false ? '最近请求失败' : '状态未知';
}
export function sourceTone(source: LiveSource): 'ok' | 'error' | 'muted' {
  if (!source.enabled || !source.health?.requestCount) return 'muted';
  if (source.health.circuitState === 'open' || source.health.healthy === false) return 'error';
  return source.health.healthy === true ? 'ok' : 'muted';
}
export function sourceSuccessRate(source: LiveSource): string {
  const requests = source.health?.requestCount;
  const successes = source.health?.successCount;
  if (!requests || requests < 0 || successes == null || !Number.isFinite(requests) || !Number.isFinite(successes)) return '—';
  return (Math.min(1, Math.max(0, successes / requests)) * 100).toFixed(1);
}
export function monitorQueueRows(data: MonitorData) {
  return [
    { key: 'crawl', label: 'TG 采集', queued: data.crawl.queued, running: data.crawl.running, failed: data.crawl.failed, blocked: 0 },
    // The sync queue exposes only its backlog. Resolve counts belong to click delivery, not local sync.
    { key: 'sync', label: '链接关联同步', queued: data.links.syncPending, running: null, failed: null, blocked: 0 },
    { key: 'checks', label: '有效性检测', ...data.links.queues.checks, blocked: 0 },
    { key: 'cleanup', label: '到期清理', ...data.links.queues.cleanup, blocked: data.links.queues.cleanup.blocked ?? 0 },
    { key: 'resolve', label: '按需取链', ...data.links.queues.resolve, blocked: 0 },
  ];
}
export function deliveryTotal(data: MonitorData): number | null {
  const stats = data.links.deliveryStats;
  return stats ? stats.transferred + stats.reused + stats.fallback + stats.direct + stats.unavailable : null;
}
export function monitorAlerts(data: MonitorData): string[] {
  const alerts: string[] = [];
  for (const [kind, label] of [['crawl', 'TG 采集'], ['links', '链接服务']] as const) {
    const worker = data.workers[kind];
    if ((worker.enabled || kind === 'links') && worker.state === 'offline') alerts.push(`${label}已启用，但没有在线 Worker。请检查服务启动配置和日志。`);
    if (worker.state === 'unknown') alerts.push(`${label}心跳暂不可读，不能确认是否在线。`);
  }
  if (data.crawl.expired) alerts.push(`有 ${data.crawl.expired} 个 TG 任务租约过期，采集恢复后会重新排队。`);
  if (data.links.queues.cleanup.blocked) alerts.push(`有 ${data.links.queues.cleanup.blocked} 个清理任务被阻塞，需要核实账号或云端产物状态。`);
  if (!data.workers.links.enabled && data.links.cleanupDue) alerts.push(`到期清理已暂停，${data.links.cleanupDue} 个到期清理任务正在等待恢复。`);
  if (data.links.checkHealth?.stuckJobs) alerts.push(`有 ${data.links.checkHealth.stuckJobs} 个有效性检测任务租约过期，Worker 恢复后会自动重新领取。`);
  return alerts;
}
export function dateLabel(value: string | number | null | undefined): string {
  if (value == null || value === '') return '暂无记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '暂无记录' : date.toLocaleString('zh-CN', { hour12: false });
}
export function lastSourceRequest(source: LiveSource): string {
  const times = [source.health?.lastSuccessAt, source.health?.lastFailureAt]
    .filter(v => v != null).map(v => new Date(v!).getTime()).filter(Number.isFinite);
  return dateLabel(times.length ? Math.max(...times) : null);
}
export type LinkTaskTone = 'ok' | 'warn' | 'error' | 'muted';
const PROVIDER_LABELS: Record<string, string> = { baidu: '百度网盘', quark: '夸克网盘' };
export function providerLabel(provider: string | null | undefined): string {
  return (provider && PROVIDER_LABELS[provider]) || '—';
}
const VALIDITY_STATES: Record<number, { label: string; tone: LinkTaskTone }> = {
  1: { label: '有效', tone: 'ok' },
  0: { label: '失效', tone: 'error' },
  [-1]: { label: '待重检', tone: 'warn' },
};
const CLEANUP_STATES: Record<string, { label: string; tone: LinkTaskTone }> = {
  queued: { label: '待处理', tone: 'muted' },
  running: { label: '执行中', tone: 'warn' },
  completed: { label: '已完成', tone: 'ok' },
  failed: { label: '失败', tone: 'error' },
  blocked: { label: '已阻塞', tone: 'error' },
};
function stateLabel(map: Record<string, { label: string; tone: LinkTaskTone }>, key: string | number | null | undefined) {
  return (key != null && map[key]) || { label: '未知', tone: 'muted' as const };
}
export interface LinkTaskRow {
  key: string; provider: string; identity: string; stateLabel: string;
  tone: LinkTaskTone; error: string; attempts: number; time: string;
}
export function checkTaskRows(data: MonitorData): LinkTaskRow[] {
  return (data.links.recentCheckFailures || []).map((row, index) => {
    const state = stateLabel(VALIDITY_STATES, row.validity);
    return {
      key: `${row.provider}-${row.identity ?? index}-${row.lastAttemptAt ?? index}`,
      provider: providerLabel(row.provider),
      identity: row.identity || '未知链接',
      stateLabel: state.label,
      tone: state.tone,
      error: row.lastErrorCode || '',
      attempts: row.failureCount,
      time: `最近尝试 ${dateLabel(row.lastAttemptAt)}`,
    };
  });
}
export function cleanupTaskRows(data: MonitorData): LinkTaskRow[] {
  return (data.links.recentCleanup || []).map((row, index) => {
    const state = stateLabel(CLEANUP_STATES, row.status);
    return {
      key: `${row.updatedAt}-${index}`,
      provider: providerLabel(row.provider),
      identity: row.stage || '',
      stateLabel: state.label,
      tone: state.tone,
      error: row.lastErrorCode || '',
      attempts: row.attempts,
      time: `更新于 ${dateLabel(row.updatedAt)}`,
    };
  });
}
