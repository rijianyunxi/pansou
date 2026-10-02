<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from 'vue';
import { Pause, Play, RefreshCw, Info } from '@lucide/vue';
import { apiFetch, apiErrorMessage } from '../../src/appRuntime';
import { useAdminConfirm } from '../../composables/admin/useAdminConfirm';
import type { WorkerStatus } from '../monitor/monitorView';
import { Button } from './ui/button';
import { Switch } from './ui/switch';
import TaskStatusBadge from './TaskStatusBadge.vue';
import { LINK_LANES, laneEnabled, laneView, workerSettings, type LinkControlKind, type LinkWorkerSettings, type ScheduledLinkKind } from '../../lib/linkWorkerControls';

const props = defineProps<{ suspended?: boolean }>();
const emit = defineEmits<{ changed: [] }>();
const confirm = useAdminConfirm();
const worker = ref<WorkerStatus|null>(null), loading = ref(false), busy = ref(''), error = ref(''), notice = ref('');
const actionError = ref('');
const checkPolicy = ref<boolean>();
const readyAccounts = ref<number>();
const lanes = computed(() => (Object.keys(LINK_LANES) as ScheduledLinkKind[]).map(key => ({
  ...LINK_LANES[key], key, enabled:laneEnabled(key,worker.value,checkPolicy.value),
  view:error.value ? {state:'uncertain',label:'读取失败'} : laneView(key,worker.value,checkPolicy.value,readyAccounts.value),
})));
let controller: AbortController|undefined, timer: ReturnType<typeof setInterval>|undefined;
let alive = true;
async function load() {
  if (loading.value || busy.value || !alive) return;
  controller = new AbortController(); const active = controller;
  loading.value = true;
  try {
    const result = await apiFetch<{data:{workers:{links:WorkerStatus};links?:{checksEnabled?:boolean;checkHealth?:{readyAccounts?:number}}}}>('/api/monitor', { signal: active.signal, cache:'no-store', silentError:true });
    if (!alive || active.signal.aborted) return;
    worker.value = result.data.workers.links; error.value = '';
    checkPolicy.value = result.data.links?.checksEnabled;
    readyAccounts.value = result.data.links?.checkHealth?.readyAccounts;
  } catch (e) { if (alive && !active.signal.aborted) error.value = apiErrorMessage(e,'读取调度状态失败，请重新读取后操作。'); }
  finally { if (alive) loading.value = false; }
}
async function toggle(kind: LinkControlKind) {
  if (!worker.value || loading.value || busy.value || error.value || props.suspended || worker.value.scheduleEnabled == null) return;
  const selected = Object.values(LINK_LANES).find(item => item.endpoint === kind);
  const current = kind==='link-schedule' ? worker.value.scheduleEnabled : lanes.value.find(item=>item.endpoint===kind)?.enabled;
  if (current == null) return;
  const name = selected?.name || '链接后台调度';
  const activateChecks = kind==='link-check' && !current && checkPolicy.value===false;
  if (activateChecks && !await confirm.confirm('启用后台有效性检测？当前检测功能已关闭，此操作将启用检测功能及其独立调度。后台会按现有账号、频率、额度和熔断策略核验排队链接，不触发转存。')) return;
  if (current && !await confirm.confirm(kind==='link-schedule'
    ? '暂停链接后台调度？关联同步、后台检测、清理和维护将在当前批次完成后暂停，队列保留。用户按需取链仍可使用；暂停期间到期和晚到产物的清理会延后。'
    : `暂停${name}？${selected?.hint} 当前批次完成后暂停，其他任务的独立开关不受影响。`)) return;
  if (!alive) return;
  busy.value = kind; error.value = ''; actionError.value = ''; notice.value = ''; controller?.abort();
  try {
    const result = await apiFetch<{data:{settings:LinkWorkerSettings;checksEnabled:boolean}}>(`/api/admin/runtime/workers/${kind}`, {method:'PUT',body:{enabled:!current,...(activateChecks?{activateChecks:true}:{})},silentError:true});
    if (!alive) return;
    Object.assign(worker.value, workerSettings(result.data.settings));
    checkPolicy.value = result.data.checksEnabled;
    notice.value = name+(!current?'已启用':'已暂停，当前批次完成后生效');
    if (selected && !current && !worker.value.scheduleEnabled) notice.value += '总调度仍暂停，此任务将在总调度恢复后执行。';
    
    emit('changed');
  } catch (e) { if (alive) actionError.value = apiErrorMessage(e,'更新调度失败，请重新读取状态后重试。'); }
  finally { if (alive) { busy.value=''; void load(); } }
}
function refreshVisible() { if (document.visibilityState==='visible'&&!props.suspended&&!confirm.open.value) void load(); }
onMounted(()=>{void load();timer=setInterval(refreshVisible,10000);document.addEventListener('visibilitychange',refreshVisible);});
onBeforeUnmount(()=>{alive=false;controller?.abort();clearInterval(timer);document.removeEventListener('visibilitychange',refreshVisible);});
</script>

<template>
  <section class="worker-controls" aria-label="链接后台调度控制" :aria-busy="!!busy||loading">
    <div class="worker-control-row">
      <div class="worker-control-title"><strong>后台调度</strong><TaskStatusBadge :state="error||worker?.scheduleEnabled==null?'uncertain':worker.scheduleEnabled?'completed':'paused'" :label="error||worker?.scheduleEnabled==null?'状态未知':worker.scheduleEnabled?'已启用':'已暂停'" /></div>
      <span class="worker-presence">{{worker?.state==='online'?`${worker.count ?? '—'} 个 Worker 在线`:worker?.state==='offline'?'Worker 离线':'Worker 状态未知'}}</span>
      <Button variant="outline" :disabled="loading||!!busy||!!error||suspended||worker?.scheduleEnabled==null" @click="toggle('link-schedule')"><component :is="worker?.scheduleEnabled?Pause:Play" :size="16" aria-hidden="true" />{{busy==='link-schedule'?'提交中…':worker?.scheduleEnabled?'暂停调度':'恢复调度'}}</Button>
      <Button variant="ghost" size="icon" title="刷新调度状态" aria-label="刷新调度状态" :disabled="loading||!!busy" @click="load()"><RefreshCw :size="15" :class="{ spinning: loading }" aria-hidden="true" /></Button>
    </div>
    <div class="lane-controls">
      <div v-for="lane in lanes" :key="lane.key" class="lane-control-row">
        <div class="lane-heading"><strong>{{lane.name}}</strong><Switch :model-value="lane.enabled === true" :aria-label="(lane.enabled?'暂停':'启用')+lane.name" :disabled="loading||!!busy||!!error||suspended||worker?.scheduleEnabled==null||lane.enabled==null" @update:model-value="toggle(lane.endpoint)" /></div>
        <TaskStatusBadge :state="lane.view.state" :label="lane.view.label" />
      </div>
    </div>
    <div class="control-footnote"><Info :size="13" aria-hidden="true" /><span>开关仅控制调度，暂停后当前批次仍会完成。</span></div>
    <p v-if="checkPolicy!==false && readyAccounts===0" class="control-error" role="status">检测无可用账号，请先连接网盘。</p>
    <p v-if="worker?.scheduleEnabled===false" class="control-hint" role="status">调度已暂停，队列和清理任务等待恢复。</p>
    <p v-else-if="worker?.state==='offline'" class="control-error" role="status">Worker 离线，请启动服务。</p>
    <p v-if="worker&&worker.scheduleEnabled==null" class="control-error" role="status">后端暂不支持调度开关。</p>
    <p v-if="error" class="control-error" role="alert">{{error}}</p>
    <p v-if="actionError" class="control-error" role="alert">{{actionError}} 请核对当前状态，确认后再重试。</p>
    <p v-if="notice" role="status">{{notice}}</p>
  </section>
</template>

<style scoped>
@layer components {
.worker-controls{border:1px solid var(--border);border-radius:10px;background:var(--card);min-width:0;font-size:12px;line-height:1.6;overflow:hidden}
.worker-control-row,.worker-control-title{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.worker-control-row{padding:14px 18px}.worker-control-title strong{font-size:14px;font-weight:600}.worker-presence{color:var(--muted-foreground);margin-right:auto;font-size:12px}
.lane-controls{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-top:1px solid var(--border);border-bottom:1px solid var(--border);background:color-mix(in srgb,var(--muted) 35%,var(--card))}
.lane-control-row{display:flex;flex-direction:column;align-items:flex-start;gap:12px;min-width:0;padding:16px 18px}.lane-control-row+.lane-control-row{border-left:1px solid var(--border)}.lane-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%}.lane-heading strong{font-weight:500;font-size:13px}
.control-footnote{display:flex;align-items:center;gap:6px;padding:10px 18px;color:var(--muted-foreground);font-size:11px}.control-hint{color:var(--muted-foreground)}.control-error{color:var(--destructive)}.worker-controls>p{overflow-wrap:anywhere;margin:0;padding:0 18px 12px}
.spinning{animation:worker-spin 1s linear infinite}@keyframes worker-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.spinning{animation:none}}
@media(max-width:1100px){.lane-controls{grid-template-columns:repeat(2,minmax(0,1fr))}.lane-control-row:nth-child(3){border-left:0}.lane-control-row:nth-child(n+3){border-top:1px solid var(--border)}}
@media(max-width:600px){.worker-control-row{gap:8px;padding:12px}.worker-control-title{margin-right:auto}.worker-presence{order:3;flex-basis:100%}.lane-control-row{padding:12px}.control-footnote{padding:10px 12px;font-size:11px}}
}
</style>
