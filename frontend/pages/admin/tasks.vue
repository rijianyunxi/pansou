<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { ListChecks, RefreshCw, Inbox } from '@lucide/vue';
import { apiFetch, apiErrorMessage, setDocumentHead } from '../../src/appRuntime';
import { TASK_KINDS, taskFilters, taskLabel, taskReason, taskObservation, type BackgroundTask } from '../../lib/backgroundTasks';
import { DELIVERY_PROVIDERS } from '../../lib/linkPolicy';
import { CLOUD_TYPE_LABELS } from '../../shared/cloudTypes';
import { Button } from '../../components/admin/ui/button';
import AdminSelect from '../../components/admin/AdminSelect.vue';
import AdminDialog from '../../components/admin/AdminDialog.vue';
import AdminRowActions from '../../components/admin/AdminRowActions.vue';
import LinkTaskTable from '../../components/admin/LinkTaskTable.vue';
import LinkWorkerControls from '../../components/admin/LinkWorkerControls.vue';
import TaskStatusBadge from '../../components/admin/TaskStatusBadge.vue';
import CleanupPage from './link-cleanup.vue';
import { useAdminConfirm } from '../../composables/admin/useAdminConfirm';
const route=useRoute(), router=useRouter(), confirm=useAdminConfirm();
const filters=computed(()=>taskFilters(route.query));
const config=computed(()=>TASK_KINDS.find(c=>c.key===filters.value.kind)!);
const supportsProvider=computed(()=>['checks','resolve'].includes(filters.value.kind));
const tasks=ref<BackgroundTask[]>([]), loading=ref(false), loaded=ref(false), error=ref(''), notice=ref('');
const nextCursor=ref<string|null>(null), enabled=ref<boolean|null>(null), updatedAt=ref('');
const detail=ref<BackgroundTask|null>(null), busy=ref(false);
const controlRevision=ref(0);
function controlsChanged(){controlRevision.value++;void load();}
let controller:AbortController|undefined, timer:ReturnType<typeof setInterval>|undefined;
function setFilter(key:string,value:string){void router.push({query:{...route.query,[key]:value||undefined,before:undefined,page:undefined}});}
function category(kind:string){void router.push({query:{kind}});}
async function load(quiet=false){
  if(filters.value.kind==='cleanup'||quiet&&loading.value)return;
  controller?.abort(); controller=new AbortController(); const active=controller;
  loading.value=true;error.value='';
  try{
    const q=new URLSearchParams({status:filters.value.status,provider:filters.value.provider});
    if(filters.value.before)q.set('before',filters.value.before);
    const result=await apiFetch<{data:{items:BackgroundTask[];nextCursor:string|null;enabled:boolean|null}}>(`/api/admin/tasks/${filters.value.kind}?${q}`,{signal:active.signal,cache:'no-store',silentError:true});
    if(active!==controller||active.signal.aborted)return;
    tasks.value=result.data.items;nextCursor.value=result.data.nextCursor;enabled.value=result.data.enabled;
    loaded.value=true;updatedAt.value=new Date().toISOString();
  }catch(e){if(!active.signal.aborted)error.value=apiErrorMessage(e,'读取链接任务失败');}
  finally{if(active===controller)loading.value=false;}
}
async function recheck(task:BackgroundTask){
  if(busy.value||loading.value||error.value||!task.canRetry||enabled.value!==true)return;
  if(!await confirm.confirm('将此链接重新加入检测队列？不会绕过频率、额度或熔断策略，也不会重新转存文件。'))return;
  busy.value=true;notice.value='';
  try{await apiFetch(`/api/admin/tasks/checks/${task.id}/retry`,{method:'POST',silentError:true});notice.value='已重新排队。执行时间仍受账号、频率、额度及熔断策略限制。';detail.value=null;await load();}
  catch(e){error.value=apiErrorMessage(e,'重新排队失败，请刷新状态');}
  finally{busy.value=false;}
}
function date(v?:string){return v&&Number.isFinite(Date.parse(v))?new Date(v).toLocaleString('zh-CN'):'未记录';}
function title(task:BackgroundTask){return filters.value.kind==='maintenance'?taskLabel(task.title):task.title||task.id;}
function refreshVisible(){if(document.visibilityState==='visible'&&!loading.value&&!busy.value&&!detail.value&&!confirm.open.value)void load(true);}
watch(filters,()=>{controller?.abort();detail.value=null;tasks.value=[];loaded.value=false;notice.value='';error.value='';nextCursor.value=null;enabled.value=null;updatedAt.value='';void load();});
onMounted(()=>{setDocumentHead({title:'链接后台处理 - pansou'});void load();timer=setInterval(refreshVisible,10000);document.addEventListener('visibilitychange',refreshVisible);});
onBeforeUnmount(()=>{controller?.abort();clearInterval(timer);document.removeEventListener('visibilitychange',refreshVisible);});
</script>
<template>
  <main class="background-tasks" :aria-busy="loading">
    <LinkWorkerControls :suspended="busy||!!detail||confirm.open.value" @changed="controlsChanged" />
    <nav class="task-categories" aria-label="链接处理分类"><Button v-for="c in TASK_KINDS" :key="c.key" :variant="filters.kind===c.key?'secondary':'ghost'" :class="{'category-active':filters.kind===c.key}" :aria-current="filters.kind===c.key?'page':undefined" @click="category(c.key)">{{c.name}}</Button></nav>
    <CleanupPage v-if="filters.kind==='cleanup'" embedded :control-revision="controlRevision" />
    <template v-else>
      <div class="task-toolbar"><label class="visually-hidden" for="task-status">任务状态</label><AdminSelect id="task-status" :model-value="filters.status" @update:model-value="setFilter('status',String($event))"><option v-for="s in config.statuses" :key="s" :value="s">{{taskLabel(s)}}</option></AdminSelect><template v-if="supportsProvider"><label class="visually-hidden" for="task-provider">网盘</label><AdminSelect id="task-provider" :model-value="filters.provider" @update:model-value="setFilter('provider',String($event))"><option value="">全部网盘</option><option v-for="p in DELIVERY_PROVIDERS" :key="p.key" :value="p.key">{{p.name}}</option></AdminSelect></template><Button variant="outline" :disabled="loading||busy" @click="load()"><RefreshCw :size="16" aria-hidden="true" />{{loading?'更新中…':'刷新'}}</Button><span class="task-meta" :title="updatedAt ? '最近更新 '+date(updatedAt) : undefined">{{busy||detail||confirm.open.value?'自动更新已暂停':'每 10 秒自动更新'}}<template v-if="updatedAt"> · {{new Date(updatedAt).toLocaleTimeString('zh-CN', {hour12:false})}}</template></span></div>
  
      <p v-if="error" role="alert" class="task-error">{{error}} {{loaded?'当前保留上次读取的结果，重试已暂时禁用。':''}}<Button variant="outline" :disabled="loading" @click="load()">重新加载</Button></p>
      <p v-if="notice" role="status">{{notice}}</p>
      <LinkTaskTable :label="config.name+'任务列表'">
        <thead><tr><th scope="col">任务</th><th scope="col">类型 / 网盘</th><th scope="col">状态</th><th scope="col">处理结果</th><th scope="col">{{filters.kind==='maintenance'?'耗时':'尝试'}}</th><th scope="col">更新时间</th><th scope="col" class="action-cell">操作</th></tr></thead>
        <tbody>
          <tr v-if="!tasks.length"><td colspan="7" class="task-empty" role="status"><div class="task-empty-content"><Inbox :size="24" stroke-width="1.5" aria-hidden="true" /><span>{{loading&&!loaded?'正在读取任务…':error?'读取失败，请重试':filters.status==='attention'?'暂无待关注任务':'暂无任务'}}</span></div></td></tr>
          <tr v-for="task in tasks" :key="task.id">
            <td class="object-cell"><strong :title="title(task)">{{title(task)}}</strong><small :title="task.id">#{{task.id}}</small></td>
            <td class="type-cell">{{taskLabel(task.kind)}}<small v-if="task.provider">{{CLOUD_TYPE_LABELS[task.provider]||task.provider}}</small></td>
            <td><TaskStatusBadge :state="task.status" :label="taskLabel(task.status)" /></td>
            <td class="result-cell"><span>{{taskObservation(task)||'—'}}</span><small v-if="task.errorCode||task.reasonCode" :title="taskReason(task.errorCode||task.reasonCode)">{{taskReason(task.errorCode||task.reasonCode)}}</small><small v-else-if="filters.kind==='checks'&&task.status==='running'">执行中，不可重复入队</small></td>
            <td class="count-cell">{{task.attempts!=null?`${task.attempts} 次`:task.durationMs!=null?`${task.durationMs} ms`:'—'}}</td>
            <td class="time-cell">{{date(task.updatedAt)}}<small v-if="task.runAfter">计划 {{date(task.runAfter)}}</small></td>
            <td class="action-cell"><AdminRowActions :label="`任务 ${task.id} 操作`"><Button variant="ghost" :disabled="busy" @click="detail=task">查看详情</Button><Button v-if="filters.kind==='checks'&&task.canRetry" variant="ghost" :disabled="busy||loading||!!error||enabled!==true" @click="recheck(task)">{{busy?'提交中…':'重新检测'}}</Button></AdminRowActions></td>
          </tr>
        </tbody>
        <template #footer><footer class="task-pagination"><span>本批 {{tasks.length}} 条</span><Button v-if="filters.before" variant="outline" :disabled="loading||busy" @click="setFilter('before','')">返回首批</Button><Button variant="outline" :disabled="!nextCursor||loading||busy" @click="router.push({query:{...route.query,before:nextCursor||undefined}})">下一批</Button></footer></template>
      </LinkTaskTable>
      <AdminDialog v-if="detail" drawer wide :busy="busy" :title="config.name+' · 任务详情'" @close="detail=null">
        <p v-if="filters.kind==='checks'" class="observation-time task-hint">当前链接观测 · 最近检测尝试 {{date(detail.lastAttemptAt)}} · 最近确认结果 {{date(detail.checkedAt)}}</p>
        <div class="task-detail"><dl><dt>任务 ID</dt><dd>{{detail.id}}</dd><dt>对象</dt><dd>{{title(detail)}}</dd><dt>状态 / 类型</dt><dd>{{taskLabel(detail.status)}} / {{taskLabel(detail.kind)}}</dd><template v-if="detail.provider"><dt>网盘</dt><dd>{{CLOUD_TYPE_LABELS[detail.provider]||detail.provider}}</dd></template><template v-if="detail.attempts!=null"><dt>尝试次数</dt><dd>{{detail.attempts}}</dd></template><dt>登记时间</dt><dd>{{date(detail.createdAt)}}</dd><dt>更新时间</dt><dd>{{date(detail.updatedAt)}}</dd><template v-if="detail.originalUrl"><dt>原始链接</dt><dd>{{detail.originalUrl}}</dd></template><template v-if="detail.runAfter"><dt>计划执行</dt><dd>{{date(detail.runAfter)}}</dd></template><template v-if="detail.leaseUntil"><dt>租约到期</dt><dd>{{date(detail.leaseUntil)}}</dd></template><template v-if="detail.deadlineAt"><dt>请求截止</dt><dd>{{date(detail.deadlineAt)}}</dd></template><template v-if="detail.validity!=null"><dt>观测结果</dt><dd>{{taskObservation(detail)}} · 连续异常 {{detail.failureCount||0}} 次</dd></template><template v-if="detail.delivery"><dt>交付结果</dt><dd>{{taskObservation(detail)}}</dd></template><template v-if="detail.durationMs!=null"><dt>批次耗时</dt><dd>{{detail.durationMs}} ms</dd></template><template v-if="detail.revision!=null"><dt>资源版本</dt><dd>{{detail.revision}}</dd></template><template v-if="detail.httpStatus!=null"><dt>响应状态码</dt><dd>{{detail.httpStatus}}</dd></template></dl><p v-if="detail.errorCode||detail.reasonCode">{{taskReason(detail.errorCode||detail.reasonCode)}}</p><p class="task-hint">{{config.hint}}</p><template v-if="filters.kind==='sync'"><RouterLink to="/admin/resources">前往网盘资源核实</RouterLink><RouterLink :to="{path:'/admin/tasks',query:{kind:'maintenance',status:'attention'}}">查看同步通道异常</RouterLink></template><RouterLink v-if="filters.kind==='resolve'" :to="{path:'/admin/tasks',query:{kind:'cleanup',status:'all',provider:detail.provider}}">查看相关网盘清理任务</RouterLink><p v-if="filters.kind==='checks'&&detail.status==='running'" class="task-hint">执行中的任务不能重复入队；过期租约由后台恢复。</p><Button v-if="filters.kind==='checks'&&detail.canRetry" :disabled="busy||loading||!!error||enabled!==true" @click="recheck(detail)">重新检测</Button></div>
      </AdminDialog>
    </template>
  </main>
</template>
<style scoped>
@layer components {
.background-tasks{display:grid;gap:20px;font-size:14px;line-height:1.6;color:var(--foreground);min-width:0}.tasks-heading,.task-toolbar,.task-categories,.task-pagination{display:flex;align-items:center;flex-wrap:wrap;gap:10px}.tasks-heading h1{display:flex;align-items:center;gap:10px;font-size:22px;font-weight:600;letter-spacing:-.5px;margin:0}.task-hint,.task-meta{color:var(--muted-foreground)}
.task-categories{gap:4px;padding:4px;border:1px solid var(--border);border-radius:8px;background:var(--muted);width:fit-content;max-width:100%}.task-categories :deep(button){height:32px;border-radius:5px;padding:0 14px}.task-categories :deep(.category-active){background:var(--card);color:var(--foreground);box-shadow:0 1px 3px rgb(0 0 0 / .08)}
.task-toolbar{gap:8px}.task-toolbar :deep(.admin-select-trigger){min-width:132px;height:36px}.task-meta{margin-left:auto;font-size:11px;font-variant-numeric:tabular-nums}.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.task-pagination{justify-content:flex-end;padding:12px 16px;border-top:1px solid var(--border)}.task-pagination>span{margin-right:auto;color:var(--muted-foreground);font-size:12px}.task-error{color:var(--destructive)}.task-empty{text-align:center;padding:56px 16px!important;color:var(--muted-foreground)}.task-empty-content{display:flex;flex-direction:column;align-items:center;gap:10px;font-size:13px}.task-empty-content svg{color:var(--muted-foreground)}
.task-detail{padding:24px;display:grid;gap:18px;overflow-wrap:anywhere}.task-detail dl{display:grid;grid-template-columns:110px minmax(0,1fr);gap:12px}.task-detail dd{margin:0}.task-detail dt{color:var(--muted-foreground)}.task-detail a{text-decoration:underline;text-underline-offset:3px}.observation-time{padding:24px 24px 0;margin:0}
@media(max-width:600px){.tasks-heading h1{font-size:20px}.task-detail dl{grid-template-columns:1fr;gap:6px}.task-categories{flex-wrap:nowrap;overflow-x:auto;width:100%}.task-categories :deep(button){flex-shrink:0;padding:0 10px}.task-meta{flex-basis:100%;margin:2px 0 0}.task-toolbar :deep(.admin-select-trigger){flex:1;min-width:115px}}
}
</style>
