<script setup lang="ts">
import {computed,ref,watch} from "vue";
import {useCrawlQuery} from "@/composables/admin/useCrawlQuery";
import {useAdminConfirm} from "@/composables/admin/useAdminConfirm";
import {apiFetch,apiErrorMessage} from "@/src/appRuntime";
import {crawlTime,crawlCompactTime,channelTaskState,compactChannelTaskLabel,type CrawlChannel,type ChannelPage} from "@/types/crawl";
import {LoaderCircle,Pause,Clock,CheckCircle2,AlertTriangle,History,Timer,Files} from "@lucide/vue";
import AdminSelect from "../AdminSelect.vue";
import AdminPagination from "../AdminPagination.vue";
import AdminRowActions from "../AdminRowActions.vue";
import {Button} from "../ui/button";
import {Input} from "../ui/input";
import {Card} from "../ui/card";
import CrawlHint from "./CrawlHint.vue";
const emit=defineEmits<{edit:[id:string];messages:[id:string,status?:string];changed:[]}>();
const q=ref(""),enabled=ref(""),page=ref(1),busy=ref<string>(),retrying=ref<string>(),actionError=ref("");
const pageSize=ref(20);
const {confirm}=useAdminConfirm();
const actionNotice=ref("");
const {data,loading,error,refresh}=useCrawlQuery<ChannelPage>(ref("/api/admin/crawl/channels"),computed(()=>({q:q.value,enabled:enabled.value,page:page.value,pageSize:pageSize.value})),5000);
const pageCount=computed(()=>Math.max(1,Math.ceil((data.value?.total||0)/pageSize.value)));
watch(enabled,()=>page.value=1);
const stateIcons={running:LoaderCircle,waiting:Clock,idle:CheckCircle2,paused:Pause,failed:AlertTriangle};
function taskIcon(c:CrawlChannel){return channelTaskState(c).state==='running'&&c.latestJob?.status!=='running'?Clock:stateIcons[channelTaskState(c).state];}
async function toggle(c:CrawlChannel){
 if(busy.value)return;busy.value=c.id;actionError.value="";
 try{
 const channel=(await apiFetch<{data:CrawlChannel}>("/api/admin/crawl/channels/"+encodeURIComponent(c.id))).data;
 await apiFetch("/api/admin/crawl/channels/"+encodeURIComponent(c.id),{method:"PUT",body:{id:c.id,name:channel.name||c.id,description:channel.description,enabled:!channel.enabled,transform:channel.transform??null,outbound:channel.outbound,expectedVersion:channel.version}});
 await refresh();emit("changed");
 }catch(e){actionError.value=apiErrorMessage(e);}finally{busy.value=undefined;}
}
function changed(){void refresh();emit("changed");}
async function remove(c:CrawlChannel){
 if(busy.value)return;
 busy.value=c.id;actionError.value="";actionNotice.value="";
 try{
  if(!await confirm(`删除频道 @${c.id}？采集任务和消息记录将一并删除，已入库资源保留。`))return;
  await apiFetch("/api/admin/crawl/channels/"+encodeURIComponent(c.id),{method:"DELETE"});
  actionNotice.value=`已删除频道 @${c.id}`;
  if(data.value?.items.length===1&&page.value>1)page.value--;
  else await refresh();
  emit("changed");
 }catch(e){actionError.value=apiErrorMessage(e);}finally{busy.value=undefined;}
}
async function retryFailed(c:CrawlChannel){
 if(retrying.value||c.latestJob?.status!=="failed")return;
 retrying.value=c.id;actionError.value="";
 try{
  await apiFetch("/api/admin/crawl/jobs/"+c.latestJob.id+"/retry",{method:"POST"});
  await refresh();emit("changed");
 }catch(e){actionError.value=apiErrorMessage(e);}finally{retrying.value=undefined;}
}
function goToPage(next:number){
 if(next<1||next>pageCount.value||next===page.value)return;
 page.value=next;
}
function changePageSize(size:number){
 pageSize.value=size;
 page.value=1;
}
defineExpose({refresh});
</script>
<template>
 <section class="crawl-channels">
  <form class="query-toolbar" @submit.prevent="page=1;refresh()">
   <Input v-model="q" placeholder="搜索频道名称 / username" aria-label="搜索频道" />
   <AdminSelect v-model="enabled" aria-label="采集状态"><option value="">全部频道</option><option value="true">采集中</option><option value="false">已暂停</option></AdminSelect>
   <Button variant="outline">查询</Button>
  </form>
  <p v-if="error||actionError" role="alert" class="form-error">{{error||actionError}}</p>
  <p v-if="actionNotice" role="status" class="tw:text-sm tw:text-muted-foreground">{{actionNotice}}</p>
  <p v-if="loading" role="status">正在加载频道…</p>
  <Card class="table-panel">
   <div class="channel-scroll"><table class="channel-table">
    <thead><tr><th>频道</th><th>任务状态</th><th>历史采集</th><th>日常采集</th><th>入库 / 失败</th><th>操作</th></tr></thead>
    <tbody><template v-for="c in data?.items" :key="c.id">
     <tr>
      <td class="channel-name"><strong :title="c.name||c.id">{{c.name||'@'+c.id}}</strong><small v-if="c.name&&c.name!==c.id&&c.name!=='@'+c.id">@{{c.id}}</small></td>
      <td><CrawlHint v-if="c.latestJob?.status==='failed'" :label="'已中断'+(c.lastError?'：'+c.lastError:'')+'，点击重新排队采集'"><Button variant="ghost" class="stat-button channel-state state-failed tw:h-7 tw:min-h-7 tw:px-2 tw:py-0 tw:gap-2 tw:justify-start tw:text-xs tw:bg-transparent" :disabled="retrying===c.id" @click="retryFailed(c)"><component :is="taskIcon(c)" :size="15" aria-hidden="true" />{{retrying===c.id?'重新排队中…':'已中断 · 点击重试'}}</Button></CrawlHint><CrawlHint v-else :label="channelTaskState(c).text+(c.lastError?'：'+c.lastError:'')"><span tabindex="0" class="channel-state" :class="'state-'+channelTaskState(c).state"><component :is="taskIcon(c)" :size="15" aria-hidden="true" :class="{spinning:channelTaskState(c).state==='running'&&c.latestJob?.status==='running'}" />{{compactChannelTaskLabel(c)}}</span></CrawlHint></td>
      <td><CrawlHint :label="'历史'+(c.historyComplete?'已补齐':'未补齐')+'，已处理 '+c.historyPages+' 页；全量采集无页数上限'"><span tabindex="0" class="history-summary"><span>{{c.historyComplete?'已补齐':!c.enabled?'未补齐':c.historyPages>0?'补齐中':'待补齐'}}</span><small>{{c.historyPages.toLocaleString('zh-CN')}} 页</small></span></CrawlHint></td>
      <td><div class="time-summary"><CrawlHint :label="'最近同步：'+crawlTime(c.lastSyncedAt)"><span tabindex="0" class="compact-value"><History :size="14" aria-hidden="true" /><time :datetime="c.lastSyncedAt||undefined">{{crawlCompactTime(c.lastSyncedAt)}}</time></span></CrawlHint><CrawlHint :label="c.enabled?'下次采集：'+crawlTime(c.nextSyncAt):'日常采集已暂停'"><span tabindex="0" class="compact-value"><Timer :size="14" aria-hidden="true" /><time v-if="c.enabled" :datetime="c.nextSyncAt">{{crawlCompactTime(c.nextSyncAt)}}</time><span v-else>暂停</span></span></CrawlHint></div></td>
      <td><div class="data-summary"><CrawlHint :label="'已入库 '+c.resourceCount.toLocaleString('zh-CN')+' 个资源，点击查看消息'"><Button variant="ghost" class="stat-button tw:h-7 tw:min-h-7 tw:px-1 tw:py-0 tw:gap-1.5 tw:justify-start tw:text-xs tw:bg-transparent" @click="emit('messages',c.id)"><Files :size="14" aria-hidden="true" />{{c.resourceCount.toLocaleString('zh-CN')}}<small>入库资源</small></Button></CrawlHint><CrawlHint :label="'解析失败 '+c.failedMessageCount.toLocaleString('zh-CN')+' 条，点击查看失败记录'"><Button variant="ghost" class="stat-button tw:h-7 tw:min-h-7 tw:px-1 tw:py-0 tw:gap-1.5 tw:justify-start tw:text-xs tw:bg-transparent" :class="{'has-failures':c.failedMessageCount>0}" @click="emit('messages',c.id,'failed')"><AlertTriangle :size="14" aria-hidden="true" />{{c.failedMessageCount.toLocaleString('zh-CN')}}<small>失败记录</small></Button></CrawlHint></div></td>
      <td class="action-column"><AdminRowActions label="频道操作"><Button variant="ghost" size="sm" class="row-action-button" :class="{'danger-action':c.enabled}" :disabled="!!busy" type="button" @click="toggle(c)">{{busy===c.id?'处理中…':c.enabled?'暂停':'继续'}}</Button><Button variant="ghost" size="sm" class="row-action-button" :disabled="!!busy" type="button" @click="emit('edit',c.id)">编辑</Button><Button variant="ghost" size="sm" class="row-action-button danger-action" :disabled="!!busy||retrying===c.id" type="button" @click="remove(c)">删除频道</Button></AdminRowActions></td>
     </tr>
    </template><tr v-if="data&&!data.items.length"><td colspan="6">暂无频道，新增后会自动开始采集。</td></tr></tbody>
   </table></div>
   <AdminPagination :page="page" :total-pages="pageCount" :total="data?.total||0" :page-size="pageSize" @change="goToPage" @update:page-size="changePageSize" />
  </Card>
 </section>
</template>
<style scoped>
@layer components {
.crawl-channels{display:grid;gap:16px}.query-toolbar input{max-width:320px}.channel-scroll{overflow-x:auto}
.channel-table{width:100%;min-width:900px;border-collapse:collapse;text-align:left;font-size:13px}
td,th{padding:12px 14px;border-bottom:1px solid var(--border);vertical-align:middle}th{font-weight:500;color:var(--muted-foreground);white-space:nowrap}
strong{font-weight:600}small{display:block;font-size:12px;color:var(--muted-foreground);line-height:1.8}
.channel-state{display:flex;align-items:center;gap:8px}
.channel-state{display:inline-flex;max-width:100%;padding:5px 9px;border-radius:6px;font-weight:500;white-space:nowrap;color:var(--state-fg);background:var(--state-bg)}
.state-running{--state-fg:#1d4ed8;--state-bg:#eff6ff}
.state-waiting{--state-fg:#9a3412;--state-bg:#fff7ed}
.state-idle{--state-fg:#047857;--state-bg:#ecfdf5}
.state-paused{--state-fg:#52525b;--state-bg:#f4f4f5}
.state-failed{--state-fg:#b91c1c;--state-bg:#fef2f2}
:global(.dark) .state-running{--state-fg:#93c5fd;--state-bg:#172554}
:global(.dark) .state-waiting{--state-fg:#fdba74;--state-bg:#431407}
:global(.dark) .state-idle{--state-fg:#6ee7b7;--state-bg:#022c22}
:global(.dark) .state-paused{--state-fg:#d4d4d8;--state-bg:#27272a}
:global(.dark) .state-failed{--state-fg:#fca5a5;--state-bg:#450a0a}
.channel-name{max-width:240px}.channel-name strong,.channel-name small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.history-summary,.time-summary,.data-summary{display:grid;gap:4px;width:fit-content;white-space:nowrap;font-variant-numeric:tabular-nums}
.compact-value{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted-foreground);white-space:nowrap}
.stat-button{height:28px;min-height:28px;padding:2px 4px;justify-content:flex-start;font-size:12px;gap:6px;font-variant-numeric:tabular-nums}
.stat-button svg:nth-of-type(2){margin-left:5px}.stat-button small{color:var(--muted-foreground);font-weight:400;margin-left:4px}.has-failures{color:var(--destructive)}
.history-summary:focus-visible,.compact-value:focus-visible,.channel-state:focus-visible{outline:2px solid var(--ring);outline-offset:3px;border-radius:4px}
.spinning{animation:spin 1.5s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinning{animation:none}}
}
</style>
