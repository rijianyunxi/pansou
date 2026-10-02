<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { Activity, AlertTriangle, ArrowUpRight, ChevronDown, CircleCheck, Database, Eraser, Layers, Link2, RadioTower, RefreshCw, ScanSearch, Send, Server } from '@lucide/vue';
import { Card } from '@/components/admin/ui/card';
import { Button } from '@/components/admin/ui/button';
import { Switch } from '@/components/admin/ui/switch';
import { Input } from '@/components/admin/ui/input';
import { Badge } from '@/components/admin/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/admin/ui/table';
import AdminDialog from '../admin/AdminDialog.vue';
import ConsoleIcon from '../sources/ConsoleIcon.vue';
import { apiFetch, apiErrorMessage } from '../../src/appRuntime';
import {
  checkTaskRows, cleanupTaskRows, dateLabel, deliveryTotal, lastSourceRequest, monitorAlerts, monitorQueueRows,
  sourceLabel, sourceSuccessRate, sourceTone, type LinkTaskTone, type LiveSource, type MonitorData, type RuntimeState,
} from './monitorView';

const emit = defineEmits<{ (event: 'unauthorized'): void }>();
const data = ref<MonitorData | null>(null);
const loading = ref(false);
const error = ref('');
const notice = ref('');
const autoRefresh = ref(true);
const search = ref('');
const busy = ref('');
const confirm = ref<'reset' | null>(null);
const workerNames = { crawl: 'TG 采集', links: '链接后台处理' } as const;
const compactButtonClass = 'tw:h-8 tw:rounded-md tw:px-3 tw:gap-1.5 tw:text-xs';
const statusBadgeClass = 'state-badge tw:rounded-md tw:border-0 tw:text-[11px] tw:font-medium tw:gap-1 tw:px-1.5 tw:py-0.5';
let timer: ReturnType<typeof setInterval> | undefined;
let controller: AbortController | undefined;
let disposed = false;

const alerts = computed(() => data.value ? monitorAlerts(data.value) : []);
const sources = computed(() => (data.value?.sources || []).filter((source) =>
  (source.name + ' ' + source.id + ' ' + (source.health?.lastErrorMessage || '')).toLowerCase().includes(search.value.trim().toLowerCase()),
));
const sourceSummary = computed(() => {
  const counts = { ok: 0, error: 0, muted: 0 };
  for (const source of data.value?.sources || []) counts[sourceTone(source)]++;
  return counts;
});
const serviceCards = computed(() => {
  if (!data.value) return [];
  const runtime = data.value;
  return [
    { key: 'api', name: 'API 服务', description: '接口与 Web 服务', icon: Server, state: runtime.services.api.state, kind: null },
    { key: 'postgres', name: 'PostgreSQL', description: '业务数据库', icon: Database, state: runtime.services.postgres.state, kind: null },
    { key: 'redis', name: 'Redis', description: '缓存与会话', icon: Layers, state: runtime.services.redis.state, kind: null },
    { key: 'crawl', name: workerNames.crawl, description: '后台 Worker', icon: RadioTower, state: runtime.workers.crawl.state, kind: 'crawl' as const },
    { key: 'links', name: workerNames.links, description: '后台 Worker', icon: Link2, state: runtime.workers.links.state, kind: 'links' as const },
  ];
});
const onlineItemCount = computed(() => serviceCards.value.filter((service) => service.state === 'online').length);
const queueRows = computed(() => data.value ? monitorQueueRows(data.value) : []);
const pressureMax = computed(() => Math.max(1, ...queueRows.value.map((row) => row.queued)));
const queueTotals = computed(() => queueRows.value.reduce((total, row) => ({
  queued: total.queued + row.queued,
  running: total.running + (row.running ?? 0),
  failed: total.failed + (row.failed ?? 0) + row.blocked,
}), { queued: 0, running: 0, failed: 0 }));
const attentionItems = computed(() => data.value ? [
  { key: 'crawl', name: 'TG 采集失败', count: data.value.crawl.failed, description: '检查最近失败任务与错误原因', path: '/admin/crawl', action: '管理采集任务', tone: 'error' },
  { key: 'review', name: '解析消息待复核', count: data.value.crawl.review, description: '需要人工确认解析结果', path: '/admin/crawl', action: '采集工作台', tone: 'warning' },
  { key: 'checks', name: '链接检测异常', count: data.value.links.checkHealth?.failing ?? data.value.links.errors, description: '查看检测记录、退避原因与重新检测入口', path: '/admin/tasks?kind=checks&status=attention', action: '管理检测任务', tone: 'error' },
  { key: 'cleanup', name: '清理失败 / 阻塞', count: data.value.links.queues.cleanup.failed + (data.value.links.queues.cleanup.blocked ?? 0), description: '查看产物记录、核实原因并重试', path: '/admin/tasks?kind=cleanup&status=attention', action: '管理清理任务', tone: 'error' },
].filter((item) => item.count > 0) : []);
const completedDeliveries = computed(() => data.value ? deliveryTotal(data.value) : null);
const checkHealth = computed(() => data.value?.links.checkHealth);
const checkTasks = computed(() => data.value ? checkTaskRows(data.value) : []);
const cleanupTasks = computed(() => data.value ? cleanupTaskRows(data.value) : []);

function formatCount(value: number | null | undefined) {
  return value == null ? '—' : value.toLocaleString('zh-CN');
}
function chartWidth(value: number) {
  return Math.max(0, Math.min(100, value / pressureMax.value * 100)) + '%';
}
function stateTone(state: RuntimeState) {
  return state === 'online' ? 'ok' : state === 'offline' || state === 'unavailable' ? 'error' : 'muted';
}
function toneClasses(tone: 'ok' | 'error' | 'muted') {
  return {
    ok: 'tw:bg-[var(--monitor-ok-bg)] tw:text-[var(--monitor-ok)]',
    error: 'tw:bg-[var(--monitor-error-bg)] tw:text-[var(--monitor-error)]',
    muted: 'tw:bg-[var(--monitor-fill)] tw:text-[var(--monitor-muted)]',
  }[tone];
}
function attentionToneClass(tone: string) {
  return tone === 'warning'
    ? 'tw:bg-[var(--monitor-warning-bg)] tw:text-[var(--monitor-warning)]'
    : 'tw:bg-[var(--monitor-error-bg)] tw:text-[var(--monitor-error)]';
}
function linkTaskToneClass(tone: LinkTaskTone) {
  return {
    ok: 'tw:bg-[var(--monitor-ok-bg)] tw:text-[var(--monitor-ok)]',
    warn: 'tw:bg-[var(--monitor-warning-bg)] tw:text-[var(--monitor-warning)]',
    error: 'tw:bg-[var(--monitor-error-bg)] tw:text-[var(--monitor-error)]',
    muted: 'tw:bg-[var(--monitor-fill)] tw:text-[var(--monitor-muted)]',
  }[tone];
}
function sourceRatePercent(source: LiveSource) {
  const value = Number.parseFloat(sourceSuccessRate(source));
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}
function serviceLabel(state: RuntimeState) {
  return state === 'online' ? '在线' : state === 'offline' ? '离线' : state === 'unavailable' ? '不可用' : '状态未知';
}
function workerEnabled(kind: 'crawl' | 'links') {
  return !!data.value?.workers[kind].enabled;
}
function scheduleLabel(kind: 'crawl' | 'links') {
  const worker = data.value?.workers[kind];
  if (kind === 'links') return worker?.scheduleEnabled == null ? '调度未知' : worker.scheduleEnabled ? '调度已启用' : '调度已暂停';
  if (!worker) return '调度状态未知';
  return '调度' + (worker.enabled ? '已启用' : '已暂停');
}
function workerToggleLabel(kind: 'crawl') {
  if (busy.value === kind) return '保存中…';
  const enabled = data.value?.workers[kind].enabled;
  return enabled ? '暂停调度' : '恢复调度';
}
function datePart(value: string | null | undefined, part: 'date' | 'time') {
  if (!value) return '暂无记录';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '暂无记录';
  return part === 'date' ? date.toLocaleDateString('zh-CN') : date.toLocaleTimeString('zh-CN', { hour12: false });
}
function handleError(e: any) {
  error.value = apiErrorMessage(e);
  if ([401, 403].includes(e?.statusCode)) {
    autoRefresh.value = false;
    emit('unauthorized');
  }
}
async function load() {
  if (loading.value || disposed) return;
  loading.value = true;
  error.value = '';
  controller = new AbortController();
  try {
    const result = await apiFetch<{ data: MonitorData }>('/api/monitor', { cache: 'no-store', signal: controller.signal });
    if (!disposed) data.value = result.data;
  } catch (e: any) {
    if (!disposed && e?.name !== 'AbortError') handleError(e);
  } finally {
    loading.value = false;
  }
}
async function toggle(kind: 'crawl') {
  if (!data.value || busy.value) return;
  await saveWorker(kind, !data.value.workers[kind].enabled);
}
async function saveWorker(kind: 'crawl', enabled: boolean) {
  busy.value = kind;
  error.value = '';
  notice.value = '';
  try {
    await apiFetch('/api/admin/runtime/workers/' + kind, { method: 'PUT', body: { enabled } });
    if (data.value) data.value.workers[kind].enabled = enabled;
    confirm.value = null;
    notice.value = workerNames[kind] + (enabled ? '已恢复调度' : '已暂停调度') + '。当前批次完成后生效。';
    await load();
  } catch (e) {
    handleError(e);
  } finally {
    busy.value = '';
  }
}
async function resetSourceStats() {
  busy.value = 'reset';
  error.value = '';
  notice.value = '';
  try {
    await apiFetch('/api/admin/monitor/reset', { method: 'POST' });
    confirm.value = null;
    notice.value = '实时来源的请求健康统计已清空。';
    await load();
  } catch (e) {
    handleError(e);
  } finally {
    busy.value = '';
  }
}
onMounted(() => {
  load();
  timer = setInterval(() => {
    if (autoRefresh.value && !document.hidden && !busy.value) load();
  }, 30_000);
});
onBeforeUnmount(() => {
  disposed = true;
  controller?.abort();
  clearInterval(timer);
});
</script>

<template>
  <div class="runtime-monitor" :aria-busy="loading">
    <header class="runtime-toolbar">
      <div class="monitor-title"><h1><Activity :size="22" aria-hidden="true" />运行监控</h1><span v-if="data" class="service-summary" :class="{ 'runtime-error': onlineItemCount < 5 }"><i class="monitor-status-dot" aria-hidden="true"></i>{{ onlineItemCount }} / 5 在线</span></div>
      <div class="toolbar-actions">
        <span v-if="data" class="updated-time" :title="dateLabel(data.generatedAt)">{{ datePart(data.generatedAt, 'time') }} 更新</span>
        <label class="refresh-switch"><Switch v-model="autoRefresh" aria-label="每 30 秒自动刷新" />30 秒自动刷新</label>
        <Button variant="outline" :class="compactButtonClass" size="sm" :disabled="loading" @click="load"><RefreshCw :size="14" :class="{ spinning: loading }" />{{ loading ? '刷新中…' : '刷新' }}</Button>
      </div>
    </header>
    <p v-if="error" class="runtime-error error-notice" role="alert"><span class="notice-copy"><AlertTriangle :size="14" class="notice-icon" /><span class="notice-text">{{ error }}<span v-if="data"> · 当前显示上次成功读取的数据</span></span></span><Button v-if="!data" size="sm" variant="outline" :disabled="loading" @click="load">重试</Button></p>
    <p v-if="notice" class="runtime-notice" role="status"><CircleCheck :size="14" class="notice-icon" /><span class="notice-text">{{ notice }}</span></p>
    <p v-if="!data && !error" class="empty-state" role="status">正在读取运行状态…</p>

    <template v-if="data">
      <section class="services-section" aria-label="服务运行状态">
        <div class="service-grid">
          <Card v-for="service in serviceCards" :key="service.key" class="service-card tw:gap-0 tw:p-4" role="article" :aria-label="service.name">
            <div class="service-card-top"><span class="service-icon"><component :is="service.icon" :size="16" aria-hidden="true" /></span><Badge variant="secondary" :class="[statusBadgeClass, toneClasses(stateTone(service.state))]"><i class="monitor-status-dot" aria-hidden="true"></i>{{ serviceLabel(service.state) }}</Badge></div>
            <h3 class="service-name">{{ service.name }}</h3>
            <div v-if="service.key === 'api'" class="service-info"><span>启动于</span><time :title="dateLabel(data.services.api.startedAt)">{{ dateLabel(data.services.api.startedAt) }}</time></div>
            <div v-else-if="service.key === 'postgres'" class="service-info"><span>连接 <b>{{ formatCount(data.services.postgres.connections) }}</b></span><span>空闲 <b>{{ formatCount(data.services.postgres.idle) }}</b></span></div>
            <div v-else-if="service.key === 'redis'" class="service-info"><span>缓存 · 会话 · 心跳</span></div>
            <div v-else-if="service.kind" class="service-info"><span><b>{{ formatCount(data.workers[service.kind].count) }}</b> 个 Worker</span><span>{{ scheduleLabel(service.kind) }}</span></div>
            <footer v-if="service.kind" class="service-actions">
              <Button v-if="service.kind==='crawl'" variant="ghost" size="sm" :class="['schedule-button', compactButtonClass]" :disabled="!!busy || loading" :aria-label="workerNames.crawl + '：' + workerToggleLabel('crawl')" @click="toggle('crawl')"><i class="schedule-dot" :class="workerEnabled('crawl') ? 'is-on' : 'is-paused'" aria-hidden="true"></i>{{ workerToggleLabel('crawl') }}</Button>
              <RouterLink v-else to="/admin/tasks" class="panel-link">管理任务<ArrowUpRight :size="13" aria-hidden="true" /></RouterLink>
            </footer>
          </Card>
        </div>
      </section>

      <Card class="monitor-panel results-panel tw:gap-0 tw:py-0" aria-label="采集与处理成果">
        <header class="panel-heading"><h2>数据概览</h2><span class="muted-label">资源存量 · 累计任务 · 24h 交付</span></header>
        <div class="result-grid">
          <article class="result-item is-collect" title="TG 当前可用资源存量"><h3><span class="result-icon"><RadioTower :size="13" /></span>可用资源 <span>条</span></h3><strong class="result-value">{{ formatCount(data.crawl.resources) }}</strong><p><span>启用频道</span><span><b>{{ formatCount(data.crawl.activeChannels) }} / {{ formatCount(data.crawl.channels) }}</b></span></p><p><span>最近同步</span><span><b>{{ dateLabel(data.crawl.lastSyncAt) }}</b></span></p></article>
          <article class="result-item is-check" title="累计检测任务数，同一链接可重复检测"><h3><span class="result-icon"><ScanSearch :size="13" /></span>累计检测 <span>次</span></h3><strong class="result-value">{{ formatCount(data.links.queues.checks.completed) }}</strong><p><span>当前有效 <b>{{ formatCount(data.links.valid) }}</b></span><span>失效 <b>{{ formatCount(data.links.invalid) }}</b></span></p><p><span>检测开关 <b>{{ data.links.checksEnabled ? '已启用' : '未启用' }}</b></span><span>已登记 <b>{{ formatCount(data.links.catalog) }}</b></span></p></article>
          <article class="result-item is-cleanup" title="累计完成的清理任务数"><h3><span class="result-icon"><Eraser :size="13" /></span>累计清理 <span>次</span></h3><strong class="result-value">{{ formatCount(data.links.queues.cleanup.completed) }}</strong><p><span>待清理 <b>{{ formatCount(data.links.queues.cleanup.queued) }}</b></span><span>阻塞 <b :class="{ 'runtime-error': (data.links.queues.cleanup.blocked ?? 0) > 0 }">{{ formatCount(data.links.queues.cleanup.blocked ?? 0) }}</b></span></p><p><span>当前到期</span><span><b>{{ formatCount(data.links.cleanupDue) }}</b></span></p></article>
          <article class="result-item is-delivery"><h3><span class="result-icon"><Send :size="13" /></span>24h 交付 <span>次</span></h3><strong class="result-value">{{ formatCount(completedDeliveries) }}</strong><template v-if="data.links.deliveryStats"><p><span>新转存 <b>{{ formatCount(data.links.deliveryStats.transferred) }}</b></span><span>复用 <b>{{ formatCount(data.links.deliveryStats.reused) }}</b></span></p><p><span>回退原链 <b>{{ formatCount(data.links.deliveryStats.fallback) }}</b></span><span>直出 <b>{{ formatCount(data.links.deliveryStats.direct) }}</b></span></p><small>确认失效 {{ formatCount(data.links.deliveryStats.unavailable) }} · 处理中 {{ formatCount(data.links.deliveryStats.processing) }}</small></template><small v-else>接口暂未返回交付统计</small></article>
        </div>

      </Card>

      <section class="secondary-grid" aria-label="任务队列与需要关注">
        <Card class="monitor-panel queue-panel tw:gap-0 tw:py-0">
          <header class="panel-heading"><h2>任务队列</h2><span class="muted-label">当前快照</span></header>
          <div class="queue-summary"><span>待处理 <strong>{{ formatCount(queueTotals.queued) }}</strong></span><span>执行中 <strong>{{ formatCount(queueTotals.running) }}</strong></span><span :class="{ 'runtime-error': queueTotals.failed > 0 }">失败 / 阻塞 <strong>{{ formatCount(queueTotals.failed) }}</strong></span></div>
          <Table class="queue-table tw:text-[11px]"><TableHeader><TableRow><TableHead>任务</TableHead><TableHead>排队量</TableHead><TableHead class="tw:text-right">执行</TableHead><TableHead class="tw:text-right">失败 / 阻塞</TableHead></TableRow></TableHeader><TableBody>
            <TableRow v-for="queue in queueRows" :key="queue.key"><TableCell><RouterLink :to="queue.key==='crawl'?'/admin/crawl':{path:'/admin/tasks',query:{kind:queue.key}}" class="panel-link">{{ queue.label }} <ConsoleIcon name="arrow" :size="12" /></RouterLink></TableCell><TableCell><div class="queue-bar"><div class="queue-track" aria-hidden="true"><span :style="{ width: chartWidth(queue.queued) }"></span></div><b>{{ formatCount(queue.queued) }}</b></div></TableCell><TableCell class="tw:text-right">{{ formatCount(queue.running) }}</TableCell><TableCell class="tw:text-right" :class="{ 'runtime-error': (queue.failed ?? 0) + queue.blocked > 0 }">{{ queue.failed == null ? '—' : formatCount(queue.failed + queue.blocked) }}</TableCell></TableRow>
          </TableBody></Table>

        </Card>

        <Card class="monitor-panel attention-panel tw:gap-0 tw:py-0" aria-label="需要关注">
          <header class="panel-heading"><h2>需要关注</h2><span class="muted-label">{{ attentionItems.length ? attentionItems.length + ' 类事项' : '暂无异常事项' }}</span></header>
          <div v-for="item in attentionItems" :key="item.key" class="attention-item"><i class="issue-dot" :class="item.tone"></i><div><h3>{{ item.name }}</h3><RouterLink :to="item.path" class="panel-link">{{ item.action }} <ConsoleIcon name="arrow" :size="12" /></RouterLink></div><strong class="attention-count" :class="attentionToneClass(item.tone)">{{ formatCount(item.count) }}</strong></div>
          <p v-if="!attentionItems.length" class="empty-state">暂无待处理异常</p>
          <details v-if="alerts.length || data.crawl.recentFailures.length" id="runtime-alerts" class="diagnostics"><summary>运行诊断与最近失败 <span>{{ alerts.length + data.crawl.recentFailures.length }}</span></summary><div class="diagnostics-body"><p v-for="alert in alerts" :key="alert">{{ alert }}</p><div v-for="(failure, index) in data.crawl.recentFailures" :key="index"><strong>{{ failure.channel }} · {{ failure.kind }}</strong><small>{{ dateLabel(failure.at) }}</small><p>{{ failure.error || '未记录错误原因' }}</p></div><p>TG 暂停任务 {{ data.crawl.paused }} · 过期租约 {{ data.crawl.expired }} · 增量同步到期频道 {{ data.crawl.overdueChannels }}</p></div></details>
        </Card>
      </section>

      <details class="task-detail">
          <summary class="task-detail-head">
            <span class="task-detail-title"><ChevronDown :size="15" aria-hidden="true" />最近链接任务</span>
            <div class="task-health">
              <span>待检测 <b>{{ formatCount(checkHealth?.due) }}</b></span>
              <span :class="{ 'runtime-error': (checkHealth?.stuckJobs ?? 0) > 0 }">租约过期 <b>{{ formatCount(checkHealth?.stuckJobs) }}</b></span>
              <span>反复失败 <b>{{ formatCount(checkHealth?.failing) }}</b></span>
              <span>待定 <b>{{ formatCount(checkHealth?.unknown) }}</b></span>
            </div>
          </summary>
          <div class="task-columns">
            <section class="task-list" aria-label="最近检测失败">
              <div class="task-list-heading"><h4>最近检测失败</h4><RouterLink to="/admin/tasks?kind=checks&status=attention" class="panel-link">查看全部<ArrowUpRight :size="12" aria-hidden="true" /></RouterLink></div>
              <p v-if="!checkTasks.length" class="task-empty">暂无失败记录</p>
              <div v-for="task in checkTasks" :key="task.key" class="task-row">
                <div class="task-title"><strong>{{ task.provider }}</strong><span class="task-identity" :title="task.identity">{{ task.identity }}</span></div>
                <div class="task-sub">
                  <Badge variant="secondary" :class="[statusBadgeClass, linkTaskToneClass(task.tone)]"><i class="monitor-status-dot"></i>{{ task.stateLabel }}</Badge>
                  <small class="task-error">{{ task.error || '未记录错误原因' }}</small>
                  <small>{{ task.time }} · 累计失败 {{ formatCount(task.attempts) }} 次</small>
                </div>
              </div>
            </section>
            <section class="task-list" aria-label="最近清理任务">
              <div class="task-list-heading"><h4>最近清理任务</h4><RouterLink to="/admin/tasks?kind=cleanup" class="panel-link">查看全部<ArrowUpRight :size="12" aria-hidden="true" /></RouterLink></div>
              <p v-if="!cleanupTasks.length" class="task-empty">暂无清理记录</p>
              <div v-for="task in cleanupTasks" :key="task.key" class="task-row">
                <div class="task-title"><strong>{{ task.provider }}</strong><span class="task-identity" :title="task.identity">{{ task.identity || '云端清理' }}</span></div>
                <div class="task-sub">
                  <Badge variant="secondary" :class="[statusBadgeClass, linkTaskToneClass(task.tone)]"><i class="monitor-status-dot"></i>{{ task.stateLabel }}</Badge>
                  <small v-if="task.error" class="task-error">{{ task.error }}</small>
                  <small>{{ task.time }} · 已尝试 {{ formatCount(task.attempts) }} 次</small>
                </div>
              </div>
            </section>
          </div>
        </details>

      <Card class="monitor-panel live-panel tw:gap-0 tw:py-0" aria-label="实时来源健康">
        <header class="panel-heading">
          <div class="title-inline"><h2>来源健康</h2><span class="muted-label">{{ sourceSummary.ok }} 正常 · <span :class="{ 'runtime-error': sourceSummary.error > 0 }">{{ sourceSummary.error }} 异常</span> · {{ sourceSummary.muted }} 未知 / 停用</span></div>
          <RouterLink to="/admin/sources" class="panel-link">管理来源 <ConsoleIcon name="external" :size="12" /></RouterLink>
        </header>
        <div class="monitor-source-toolbar"><Input v-model="search" class="monitor-source-search" aria-label="搜索实时来源名称、ID 或错误" placeholder="搜索来源…" /><Button variant="ghost" size="sm" :class="compactButtonClass" :disabled="!!busy || loading || !data.sources.length" @click="confirm = 'reset'">清空来源统计</Button></div>
        <div v-if="sources.length" class="source-grid">
          <article v-for="source in sources" :key="source.id" class="source-item" :aria-label="source.name">
            <div class="source-top"><h3 :title="source.name + ' · ' + source.id">{{ source.name }}</h3><Badge variant="secondary" :class="[statusBadgeClass, 'source-badge', toneClasses(sourceTone(source))]"><i class="monitor-status-dot"></i>{{ sourceLabel(source) }}</Badge></div>
            <div class="source-key"><div class="source-rate" :class="'rate-' + sourceTone(source)"><strong>{{ sourceSuccessRate(source) }}</strong><small>{{ sourceSuccessRate(source) === '—' ? '成功率' : '% 成功率' }}</small><div class="source-rate-track" aria-hidden="true"><span :style="{ width: sourceRatePercent(source) + '%' }"></span></div></div><div class="source-latency"><b>{{ source.health?.requestCount && source.health.avgResponseTime != null ? formatCount(source.health.avgResponseTime) + ' ms' : '—' }}</b><small>平均耗时</small></div></div>
            <dl class="source-counts"><div><dt>请求</dt><dd>{{ formatCount(source.health?.requestCount ?? 0) }}</dd></div><div><dt>成功</dt><dd>{{ formatCount(source.health?.successCount ?? 0) }}</dd></div><div><dt>失败</dt><dd :class="{ 'runtime-error': (source.health?.totalFailureCount ?? 0) > 0 }">{{ formatCount(source.health?.totalFailureCount ?? 0) }}</dd></div><div><dt>零结果</dt><dd>{{ formatCount(source.health?.zeroResultCount ?? 0) }}</dd></div></dl>
            <div class="source-bottom"><p>最近请求 {{ lastSourceRequest(source) }}</p><small v-if="source.health?.lastErrorMessage" class="runtime-error">最近错误：{{ source.health.lastErrorMessage }}</small></div>
          </article>
        </div>
        <p v-else class="empty-state">{{ search ? '没有匹配的来源。' : '暂无实时外部来源。' }}</p>

      </Card>


    </template>

    <AdminDialog v-if="confirm" title="清空实时来源统计？" :busy="!!busy" @close="confirm = null"><p>将清空实时来源的请求计数、失败记录和来源熔断统计。代理节点额度及冷却状态、TG 采集和链接任务记录均保留。</p><p v-if="error" class="runtime-error" role="alert">{{ error }}</p><div class="dialog-actions"><Button variant="outline" :disabled="!!busy" @click="confirm = null">取消</Button><Button :disabled="!!busy" @click="resetSourceStats()">{{ busy ? '处理中…' : '确认' }}</Button></div></AdminDialog>
  </div>
</template>

<style scoped>
@layer components {
  .runtime-monitor {
    --monitor-ink: var(--foreground); --monitor-muted: var(--muted-foreground); --monitor-line: var(--border);
    --monitor-accent: var(--foreground); --monitor-accent-bg: var(--muted); --monitor-fill: var(--muted);
    --monitor-ok: #15803d; --monitor-ok-bg: #f0fdf4;
    --monitor-error: var(--destructive); --monitor-error-bg: #fef2f2;
    --monitor-warning: #a16207; --monitor-warning-bg: #fefce8;
    --monitor-card-border: var(--border); --monitor-head-bg: var(--muted); --monitor-bar: #71717a;
    display: grid; gap: 20px; min-width: 0; color: var(--foreground); font-size: 13px;
  }
  .monitor-title { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }.monitor-title h1 { display: flex; align-items: center; gap: 10px; }.updated-time { color: var(--muted-foreground); font-size: 11px; font-variant-numeric: tabular-nums; }
  .runtime-toolbar, .toolbar-actions, .section-heading, .panel-heading, .title-inline, .monitor-source-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  h1 { font-size: 22px; font-weight: 600; letter-spacing: -.5px; }
  h2 { font-size: 14px; font-weight: 600; }
  h3 { font-size: 13px; font-weight: 600; }
  p, small, dt, .muted-label { color: var(--monitor-muted); }
  small { display: block; font-size: 11px; }
  .toolbar-actions { justify-content: flex-end; }
  .refresh-switch { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--monitor-muted); }
  .runtime-monitor :deep([data-slot="button"]) { font-size: 12px; border-radius: 6px; }
  .runtime-error { color: var(--monitor-error) !important; }
  .error-notice, .runtime-notice { gap: 8px; padding: 11px 14px; border-radius: 8px; font-size: 12px; }
  .error-notice { display: flex; align-items: flex-start; justify-content: space-between; background: var(--monitor-error-bg); border-left: 3px solid var(--monitor-error); }
  .runtime-notice { display: flex; align-items: flex-start; background: var(--monitor-ok-bg); color: var(--monitor-ok); border-left: 3px solid var(--monitor-ok); }
  .notice-copy { display: flex; align-items: flex-start; gap: 8px; flex: 1; min-width: 0; }
  .notice-icon { flex: none; margin-top: 2px; }
  .notice-text { min-width: 0; overflow-wrap: anywhere; }
  .section-heading { margin-bottom: 12px; }
  .title-inline { justify-content: flex-start; }
  .muted-label, .service-summary { font-size: 11px; }
  .service-summary { display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; border-radius: 5px; background: var(--monitor-ok-bg); color: var(--monitor-ok); }
  .service-summary.runtime-error { background: var(--monitor-error-bg); }
  .monitor-status-dot, .issue-dot, .schedule-dot { display: inline-block; flex: none; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
  .schedule-dot { width: 6px; height: 6px; }
  .schedule-dot.is-on { background: var(--monitor-ok); }
  .schedule-dot.is-paused { background: var(--monitor-warning); }
  .service-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; }
  .service-card { min-width: 0; padding: 16px; background: var(--card); border: 1px solid var(--border); border-radius: 8px; }
  .service-card-top { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 6px; }
  .service-icon { display: grid; place-items: center; flex: none; width: 28px; height: 28px; border-radius: 6px; background: var(--muted); color: var(--muted-foreground); }
  .state-badge { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; white-space: normal; border: 0; border-radius: 5px; font-size: 11px; font-weight: 400; line-height: 1.5; }
  .service-name { margin: 10px 0 8px; font-size: 13px; font-weight: 600; }
  .service-info { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; font-size: 11px; color: var(--muted-foreground); }.service-info b { color: var(--foreground); font-weight: 500; }.service-info time { font-variant-numeric: tabular-nums; }
  .service-actions { display: flex; align-items: center; margin-top: auto; padding-top: 10px; }.service-actions .schedule-button { padding: 0; height: 22px; color: var(--muted-foreground); font-size: 11px; min-height: 22px; }
  .section-note, .panel-note { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; color: var(--monitor-muted); font-size: 11px; }
  .monitor-panel { min-width: 0; border-color: var(--monitor-card-border); color: var(--monitor-ink); }
  .panel-heading { padding: 15px 16px; }
  .results-panel { background: var(--card); }
  .result-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); padding-bottom: 18px; }
  .result-item { min-width: 0; padding: 0 16px; border-right: 1px solid var(--monitor-line); }
  .result-item:last-child { border-right: 0; }
  .result-item h3 { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 500; color: var(--monitor-muted); }
  .result-item h3 span:not(.result-icon) { margin-left: -2px; font-size: 11px; font-weight: 400; }
  .result-icon { display: inline-grid; place-items: center; flex: none; width: 22px; height: 22px; border-radius: 5px; color: var(--muted-foreground); background: var(--muted); }
  .result-value { display: block; margin: 10px 0 12px; font-size: 28px; font-weight: 500; letter-spacing: -.9px; font-variant-numeric: tabular-nums; color: var(--monitor-ink); }
  .result-item p { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 2px 12px; margin-bottom: 5px; font-size: 11px; overflow-wrap: anywhere; }
  .result-item b { font-weight: 500; color: var(--monitor-ink); font-variant-numeric: tabular-nums; }
  .panel-link { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--monitor-muted); text-decoration: none; transition: color .15s; }
  .panel-link:hover { color: var(--monitor-accent); }
  .attention-item:hover .panel-link { color: var(--monitor-accent); }
  .monitor-source-toolbar { padding: 0 16px 16px; }
  .monitor-source-search { max-width: 290px; height: 36px; border-radius: 6px; font-size: 12px; }
  .source-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); row-gap: 18px; }
  .source-item { min-width: 0; padding: 0 16px 14px; border-right: 1px solid var(--monitor-line); }
  .source-item:nth-child(4n) { border-right: 0; }
  .source-top { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 8px; min-height: 28px; }
  .source-top h3 { flex: 1; min-width: 0; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .source-badge { flex: none; }
  .source-key { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin: 12px 0; }
  .source-rate { display: grid; justify-items: start; gap: 2px; min-width: 0; color: var(--monitor-muted); }
  .source-rate strong { font-size: 23px; font-weight: 500; line-height: 1.2; font-variant-numeric: tabular-nums; }
  .rate-ok { color: var(--foreground); }
  .rate-error { color: var(--monitor-error); }
  .rate-muted { color: var(--monitor-muted); }
  .source-rate-track { width: 96px; max-width: 100%; height: 3px; overflow: hidden; border-radius: 5px; background: var(--monitor-line); }
  .source-rate-track span { display: block; height: 100%; border-radius: 5px; background: currentColor; transition: width .3s; }
  .source-latency { text-align: right; font-size: 12px; font-variant-numeric: tabular-nums; }
  .source-latency b { font-weight: 500; }
  .source-counts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 5px; margin: 0; font-size: 11px; }
  .source-counts > div + div { border-left: 1px solid var(--monitor-line); padding-left: 8px; }
  .source-counts dd { margin: 2px 0 0; font-size: 12px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .source-bottom { margin-top: 12px; padding-top: 9px; border-top: 1px solid var(--monitor-line); font-size: 11px; }
  .source-bottom p, .source-bottom small { overflow-wrap: anywhere; }
  .source-bottom small { margin-top: 4px; }
  .panel-note { padding: 10px 16px; border-top: 1px solid var(--monitor-line); }
  .secondary-grid { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 16px; align-items: start; }
  .queue-summary { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 16px 12px; }
  .queue-summary span { display: inline-flex; align-items: center; gap: 7px; padding: 5px 11px; border-radius: 5px; background: var(--monitor-fill); color: var(--monitor-muted); font-size: 11px; }
  .queue-summary strong { margin-left: 0; font-size: 15px; font-weight: 500; font-variant-numeric: tabular-nums; color: var(--monitor-ink); }
  .queue-summary span.runtime-error { background: var(--monitor-error-bg); }
  .queue-summary span.runtime-error strong { color: var(--monitor-error); }
  .queue-table { font-size: 11px; }
  .queue-panel :deep([data-slot="table-head"]), .queue-panel :deep([data-slot="table-cell"]) { padding: 10px 12px; font-size: 11px; font-variant-numeric: tabular-nums; }
  .queue-panel :deep([data-slot="table-head"]) { height: auto; background: var(--monitor-head-bg); color: var(--monitor-muted); font-weight: 400; }
  .queue-panel :deep([data-slot="table-row"]) { border-color: var(--monitor-line); }
  .queue-panel :deep([data-slot="table-cell"]:first-child), .queue-panel :deep([data-slot="table-head"]:first-child) { padding-left: 16px; }
  .queue-panel :deep([data-slot="table-cell"]:last-child), .queue-panel :deep([data-slot="table-head"]:last-child) { padding-right: 16px; }
  .queue-bar { display: flex; align-items: center; gap: 10px; min-width: 115px; }
  .queue-bar b { min-width: 30px; font-weight: 500; text-align: right; }
  .queue-track { flex: 1; min-width: 50px; height: 6px; overflow: hidden; border-radius: 5px; background: var(--muted); }
  .queue-track span { display: block; height: 100%; border-radius: 5px; background: var(--monitor-bar); }
  .attention-panel > .panel-heading { border-bottom: 1px solid var(--monitor-line); }
  .attention-item { display: flex; align-items: flex-start; gap: 8px; margin: 0 10px; padding: 11px 6px; border-bottom: 1px solid var(--monitor-line); border-radius: 8px; transition: background .15s; }
  .attention-item:last-child { border-bottom: 0; }
  .attention-item:hover { background: var(--monitor-fill); }
  .issue-dot { margin-top: 7px; color: var(--monitor-error); }
  .issue-dot.warning { color: var(--monitor-warning); }
  .attention-item > div { flex: 1; min-width: 0; }
  .attention-item h3 { font-size: 12px; }
  .attention-item p { font-size: 11px; margin: 2px 0 3px; }
  .attention-count { flex: none; margin-top: 1px; padding: 2px 9px; border-radius: 5px; font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; }
  .empty-state { padding: 16px; font-size: 12px; color: var(--monitor-muted); }
  .diagnostics { margin: 10px 16px 14px; font-size: 11px; }
  .diagnostics summary { display: flex; align-items: center; gap: 6px; list-style: none; color: var(--monitor-muted); cursor: pointer; }
  .diagnostics summary::-webkit-details-marker { display: none; }
  .diagnostics summary::after { content: ''; flex: none; width: 6px; height: 6px; margin-left: 2px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(-45deg); transition: transform .15s; }
  .diagnostics[open] summary::after { transform: rotate(45deg); margin-top: -3px; }
  .diagnostics summary span { margin-left: 0; font-variant-numeric: tabular-nums; }
  .diagnostics-body { display: grid; gap: 10px; padding-top: 10px; overflow-wrap: anywhere; }
  .diagnostics-body strong { display: block; font-size: 11px; }
  .task-detail { min-width: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--card); }.task-detail[open] .task-detail-head { border-bottom: 1px solid var(--border); }
  .task-detail-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 14px 16px; cursor: pointer; list-style: none; }
  .task-detail-head::-webkit-details-marker { display: none; }.task-detail-title { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 500; }.task-detail-title svg { transform: rotate(-90deg); }.task-detail[open] .task-detail-title svg { transform: none; }
  .task-health { display: flex; flex-wrap: wrap; gap: 6px; }
  .task-health span { display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; border-radius: 5px; background: var(--monitor-fill); color: var(--monitor-muted); font-size: 11px; }
  .task-health b { font-weight: 500; font-variant-numeric: tabular-nums; color: var(--monitor-ink); }
  .task-health span.runtime-error { background: var(--monitor-error-bg); }
  .task-health span.runtime-error b { color: var(--monitor-error); }
  .task-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; padding: 16px; }
  .task-list { min-width: 0; }
  .task-list-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }.task-list h4 { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; font-size: 11px; font-weight: 500; color: var(--monitor-muted); }
  .task-empty { padding: 8px 0; font-size: 11px; }
  .task-row { padding: 8px 0; border-top: 1px solid var(--monitor-line); }
  .task-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .task-title strong { flex: none; font-size: 11px; font-weight: 500; }
  .task-identity { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--monitor-muted); }
  .task-sub { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; margin-top: 5px; }
  .task-error { overflow-wrap: anywhere; }
  .task-sub small { font-size: 10.5px; }
  .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
  .spinning { animation: monitor-spin 1s linear infinite; }
  @keyframes monitor-spin { to { transform: rotate(360deg); } }
  @media (max-width: 1100px) {
    .service-actions { gap: 4px; }
  }
  @media (max-width: 1150px) {
    .service-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .result-grid, .source-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); row-gap: 18px; }
    .result-item:nth-child(2n), .source-item:nth-child(2n) { border-right: 0; }
    .secondary-grid { grid-template-columns: 1fr; }
  }
  @media (max-width: 600px) {
    .runtime-toolbar { align-items: flex-start; }
    .toolbar-actions { justify-content: flex-start; }
    .updated-time { display: none; }
    .task-columns, .secondary-grid, .source-grid { grid-template-columns: minmax(0, 1fr); }
    .source-item { border-right: 0; }
    .service-grid { grid-template-columns: minmax(0, 1fr); gap: 8px; }
    .service-card { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; align-items: center; gap: 6px 10px; padding: 12px; }
    .service-card-top { display: contents; }
    .service-icon { grid-column: 1; grid-row: 1 / 3; }
    .service-card-top :deep(.state-badge) { grid-column: 3; grid-row: 1; justify-self: end; }
    .service-name { grid-column: 2; grid-row: 1; margin: 0; }
    .service-info { grid-column: 2; grid-row: 2; }
    .service-actions { grid-column: 3; grid-row: 2; padding: 0; margin: 0; }
    .result-item p { gap: 4px; }
    .monitor-source-search { max-width: none; flex: 1; min-width: 170px; }
  }
  @media (max-width: 380px) {
    .service-grid, .result-grid, .source-grid { grid-template-columns: 1fr; }
    .result-item, .source-item { border-right: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .service-card, .attention-item, .panel-link, .panel-link svg, .source-rate-track span { transition: none; }
    .spinning { animation: none; }
  }
}
</style>
