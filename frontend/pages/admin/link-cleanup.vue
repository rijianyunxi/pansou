<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { RefreshCw, ListChecks } from '@lucide/vue';
import { apiFetch, apiErrorMessage, setDocumentHead } from '../../src/appRuntime';
import { CLOUD_TYPE_LABELS } from '../../shared/cloudTypes';
import { Button } from '../../components/admin/ui/button';
import AdminSelect from '../../components/admin/AdminSelect.vue';
import AdminPagination from '../../components/admin/AdminPagination.vue';
import AdminDialog from '../../components/admin/AdminDialog.vue';
import AdminRowActions from '../../components/admin/AdminRowActions.vue';
import LinkTaskTable from '../../components/admin/LinkTaskTable.vue';
import TaskStatusBadge from '../../components/admin/TaskStatusBadge.vue';
import { useAdminConfirm } from '../../composables/admin/useAdminConfirm';
import type { MonitorData } from '../../components/monitor/monitorView';
import { DELIVERY_PROVIDERS } from '../../lib/linkPolicy';
import { cleanupFilters, cleanupLabel, cleanupError, retryUnavailable } from '../../lib/cleanupTasks';
const props = defineProps<{ embedded?: boolean; controlRevision?: number }>();
if (!props.embedded) setDocumentHead({ title: '清理任务 - pansou' });
interface Task { id: number; provider: string; originalUrl: string; status: string; stage: string; lastErrorCode: string | null; attempts: number; runAfter: string; cleanupAfter: string; updatedAt: string; artifactState: string; targetDir: string; ownedDirId: string | null; ownedDirPath: string | null; directoryName: string | null; writeStage: string | null; files: Array<{ parent: string; file: { id: string; name: string } }> | null; shares: string[]; progress: unknown; canRetry: boolean; retryUnavailableReason: string | null }
const route = useRoute(), router = useRouter();
const filters = computed(() => cleanupFilters(route.query));
const page = computed(() => filters.value.page), status = computed(() => filters.value.status);
const tasks = ref<Task[]>([]), total = ref(0);
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / filters.value.pageSize)));
const loading = ref(false), busy = ref<number | null>(null), error = ref(''), notice = ref('');
const detail = ref<Task | null>(null), paused = ref<boolean | null>(null), loaded = ref(false), updatedAt = ref('');
const fileLimit = ref(50);
const visibleFiles = computed(() => detail.value?.files?.slice(0, fileLimit.value) || []);
const confirm = useAdminConfirm();
let controller: AbortController | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
function filter(key: 'status' | 'provider', value: string) { void router.replace({ query: { ...route.query, [key]: value || undefined, before: undefined, page: undefined } }); }
function changePage(value: number) { void router.replace({ query: { ...route.query, before: undefined, page: value > 1 ? String(value) : undefined } }); }
function changePageSize(value: number) { if (loading.value || busy.value != null) return; void router.replace({ query: { ...route.query, before: undefined, page: undefined, pageSize: String(value) } }); }
async function load(quiet = false) {
  if (quiet && loading.value) return;
  controller?.abort(); controller = new AbortController(); const active = controller;
  loading.value = true; error.value = '';
  try {
    const query = new URLSearchParams({ status: status.value, page: String(page.value), pageSize: String(filters.value.pageSize), provider: filters.value.provider });
    const result = await apiFetch<{ data: { items: Task[]; total: number } }>(`/api/admin/link-cleanup?${query}`, { signal: active.signal, cache: 'no-store', silentError: true });
    if (controller !== active || active.signal.aborted) return;
    tasks.value = result.data.items; total.value = result.data.total;
    loaded.value = true; updatedAt.value = new Date().toISOString();
    if (page.value > totalPages.value) changePage(totalPages.value);
    if (detail.value) detail.value = tasks.value.find(t => t.id === detail.value?.id) || null;
  } catch (e) { if (!active.signal.aborted) error.value = apiErrorMessage(e, '读取清理任务失败，请重试。'); }
  finally { if (controller === active) loading.value = false; }
}
async function refreshWorker() {
  const signal = controller?.signal;
  try { const r = await apiFetch<{ data: MonitorData }>('/api/monitor', { silentError: true, cache: 'no-store', signal }); if (!signal?.aborted) paused.value = !r.data.workers.links.enabled || r.data.workers.links.scheduleEnabled === false; }
  catch { if (!signal?.aborted) paused.value = null; }
}
async function retry(task: Task) {
  if (busy.value != null || loading.value || error.value || !task.canRetry) return;
  if (!await confirm.confirm(`重新核实并清理任务 #${task.id}？将重新校验当前账号、目录身份和文件清单。校验不通过仍会阻塞；不会强制删除或清空回收站。`)) return;
  busy.value = task.id; error.value = ''; notice.value = '';
  try {
    await apiFetch(`/api/admin/link-cleanup/${task.id}/retry`, { method: 'POST', silentError: true });
    notice.value = paused.value === true ? '已加入队列，但到期清理处于暂停状态，请在本页上方控制区恢复清理调度。' : paused.value === null ? '已加入队列；暂无法确认清理服务状态，可前往运行监控核实。' : '已加入清理队列，后台会重新核实并清理。';
    detail.value = null; await load();
  } catch (e) { error.value = apiErrorMessage(e, '重试失败，请刷新任务状态。'); }
  finally { busy.value = null; }
}
function date(value: string) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '未记录'; }
watch(filters, () => { detail.value = null; void load(); });
watch(() => detail.value?.id, () => { fileLimit.value = 50; });
watch(() => props.controlRevision, () => { void load(); void refreshWorker(); });
function refreshVisible() { if (document.visibilityState === 'visible' && !loading.value && busy.value == null && !detail.value && !confirm.open.value) { void load(true); void refreshWorker(); } }
onMounted(() => { void load(); void refreshWorker(); timer = setInterval(refreshVisible, 10000); document.addEventListener('visibilitychange', refreshVisible); });
onBeforeUnmount(() => { controller?.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', refreshVisible); });
</script>
<template>
  <component :is="embedded?'section':'main'" class="cleanup-page" :aria-busy="loading" aria-label="链接清理">
    <header class="cleanup-heading"><div><h1 v-if="!embedded"><ListChecks :size="24" aria-hidden="true" />清理任务</h1><p>管理到期或取链超时的转存产物。重试仍严格检查账号、目录和文件归属。</p></div><Button variant="outline" :disabled="loading" @click="load(); refreshWorker()"><RefreshCw :size="16" />{{ loading ? '更新中…' : '刷新' }}</Button></header>
    <div class="cleanup-toolbar"><label for="cleanup-status">任务状态</label><AdminSelect id="cleanup-status" :model-value="status" @update:model-value="filter('status', String($event))"><option value="attention">需要关注</option><option value="all">全部任务</option><option value="queued">等待清理</option><option value="running">清理中</option><option value="blocked">已阻塞</option><option value="failed">已失败</option><option value="completed">已完成</option></AdminSelect><label for="cleanup-provider">网盘</label><AdminSelect id="cleanup-provider" :model-value="filters.provider" @update:model-value="filter('provider', String($event))"><option value="">全部网盘</option><option v-for="p in DELIVERY_PROVIDERS" :key="p.key" :value="p.key">{{ p.name }}</option></AdminSelect><span>共 {{ total }} 条</span><RouterLink to="/admin/cloud-accounts">配置网盘账号与策略</RouterLink></div>
    <p v-if="updatedAt" class="task-meta">每 10 秒更新（详情或确认框打开时暂停）· 最近更新 {{ date(updatedAt) }}</p>
    <p v-if="error" role="alert" class="cleanup-error">{{ error }} {{ loaded ? '当前显示上次读取的结果，重试已暂时禁用。' : '' }} <Button variant="outline" :disabled="loading" @click="load(); refreshWorker()">重新加载</Button></p><p v-if="notice" role="status">{{ notice }} <Button v-if="status !== 'queued'" variant="outline" @click="filter('status','queued')">查看等待清理</Button></p>
    <LinkTaskTable label="清理任务列表">
      <thead><tr><th scope="col">任务 / 云端产物</th><th scope="col">网盘</th><th scope="col">任务状态</th><th scope="col">处理阶段 / 原因</th><th scope="col">尝试</th><th scope="col">更新时间 / 计划执行</th><th scope="col" class="action-cell">操作</th></tr></thead>
      <tbody>
        <tr v-if="!tasks.length"><td colspan="7" class="cleanup-empty" role="status">{{loading&&!loaded?'正在读取任务…':error?'暂无法读取任务，请重新加载。':status==='attention'?'目前没有需要关注的清理任务。可切换“全部任务”查看历史。':'没有符合条件的任务。'}}</td></tr>
        <tr v-for="task in tasks" :key="task.id">
          <td class="object-cell"><strong :title="task.directoryName || task.ownedDirPath || task.ownedDirId || ''">{{task.directoryName || task.ownedDirPath || task.ownedDirId || '尚未确认云端产物'}}</strong><small>#{{task.id}}</small></td>
          <td>{{CLOUD_TYPE_LABELS[task.provider] || task.provider}}</td>
          <td><TaskStatusBadge :state="task.status" :label="cleanupLabel(task.status)" /></td>
          <td class="result-cell">{{cleanupLabel(task.stage)}}<small v-if="task.lastErrorCode" :title="cleanupError(task.lastErrorCode,task.status)">{{cleanupError(task.lastErrorCode,task.status)}}</small><small v-else-if="!task.canRetry" :title="retryUnavailable(task.retryUnavailableReason)">{{retryUnavailable(task.retryUnavailableReason)}}</small></td>
          <td>{{task.attempts}} 次</td>
          <td class="time-cell">{{date(task.updatedAt)}}<small>计划 {{date(task.runAfter)}}</small></td>
          <td class="action-cell"><AdminRowActions :label="`清理任务 ${task.id} 操作`"><Button variant="ghost" :disabled="busy != null" @click="detail=task">查看产物与详情</Button><Button v-if="task.canRetry" variant="ghost" :disabled="busy != null || loading || !!error" @click="retry(task)">{{busy===task.id?'提交中…':'核实后重试'}}</Button></AdminRowActions></td>
        </tr>
      </tbody>
      <template #footer><AdminPagination :page="page" :total-pages="totalPages" :total="total" :page-size="filters.pageSize" :disabled="loading || busy != null" @change="changePage" @update:page-size="changePageSize" /></template>
    </LinkTaskTable>
    <AdminDialog v-if="detail" drawer wide :busy="busy != null" :title="`清理任务 #${detail.id}`" description="核实账号、目录和文件清单后再重试。没有强制删除入口。" @close="detail = null">
      <div class="cleanup-detail"><p v-if="detail.lastErrorCode" class="cleanup-error">{{ cleanupError(detail.lastErrorCode,detail.status) }}</p><dl><dt>原始分享</dt><dd>{{ detail.originalUrl }}</dd><dt>项目目录</dt><dd>{{ detail.targetDir }}</dd><dt>本流程子目录</dt><dd>{{ detail.ownedDirPath || detail.ownedDirId || '未确认' }}</dd><dt>产物状态 / 写入阶段</dt><dd>{{ cleanupLabel(detail.artifactState) }} / {{ cleanupLabel(detail.writeStage) }}</dd><dt>清理到期时间</dt><dd>{{ date(detail.cleanupAfter) }}</dd><dt>计划尝试时间</dt><dd>{{ date(detail.runAfter) }}</dd><dt>已创建分享 ID</dt><dd>{{ detail.shares.join('、') || '无已确认分享' }}</dd></dl><h3>已确认的文件清单（{{ detail.files?.length || 0 }}）</h3><ul v-if="visibleFiles.length"><li v-for="entry in visibleFiles" :key="entry.file.id">{{ entry.file.name }} · {{ entry.file.id }}</li></ul><p v-else>未记录文件清单；产物不确定时仍需核实，重试不会跳过此检查。</p><Button v-if="(detail.files?.length || 0) > fileLimit" variant="outline" @click="fileLimit += 50">显示更多文件</Button><p v-if="!detail.canRetry" class="task-meta">{{ retryUnavailable(detail.retryUnavailableReason) }}</p><Button v-else :disabled="busy != null || loading || !!error" @click="retry(detail)">{{ busy === detail.id ? '提交中…' : '核实后重试' }}</Button></div>
    </AdminDialog>
  </component>
</template>
<style scoped>
@layer components {
.cleanup-page { display:grid; gap:16px; min-width:0; color:var(--foreground); font-size:14px; line-height:1.6; }
.cleanup-heading,.cleanup-toolbar,.task-heading,.task-actions { display:flex; align-items:center; flex-wrap:wrap; gap:12px; }
.cleanup-heading,.task-heading { justify-content:space-between; }.cleanup-heading h1 { display:flex; align-items:center; gap:10px; font-size:24px; margin:0; }.cleanup-heading p,.task-meta { color:var(--muted-foreground); }.cleanup-toolbar span { margin-right:auto; }.cleanup-toolbar a,.cleanup-warning a { text-decoration:underline; text-underline-offset:3px; }
.cleanup-page button { min-height:44px; }.cleanup-error { color:var(--destructive); }.cleanup-warning { padding:16px; border:1px solid var(--border); border-radius:8px; background:var(--muted); }.cleanup-empty { text-align:center; padding:32px!important; color:var(--muted-foreground); }.cleanup-detail { padding:24px; overflow-wrap:anywhere; }.cleanup-detail dl { display:grid; grid-template-columns:120px minmax(0,1fr); gap:12px; }.cleanup-detail dd { margin:0; }.cleanup-detail dt { color:var(--muted-foreground); }
.cleanup-toolbar :deep(.admin-select-trigger) { min-height:44px; }
@media(max-width:600px) { .cleanup-page { font-size:16px; }.cleanup-heading { align-items:flex-start; }.cleanup-detail dl { grid-template-columns:1fr; gap:6px; }.cleanup-toolbar { align-items:flex-start; } }
}
</style>
