<script setup lang="ts">
import {computed,ref,watch} from "vue";
import {useCrawlQuery} from "@/composables/admin/useCrawlQuery";
import {apiFetch,apiErrorMessage} from "@/src/appRuntime";
import {crawlTime,crawlCompactTime,channelTaskState,compactChannelTaskLabel,type CrawlChannel,type ChannelPage} from "@/types/crawl";
import {LoaderCircle,Pause,Clock,CheckCircle2,AlertTriangle,History,Timer,MessageSquare,Files,ListChecks} from "@lucide/vue";
import AdminSelect from "../AdminSelect.vue";
import {Button} from "../ui/button";
import {Input} from "../ui/input";
import {Card} from "../ui/card";
import CrawlChannelActivity from "./CrawlChannelActivity.vue";
import CrawlHint from "./CrawlHint.vue";
const emit=defineEmits<{edit:[id:string];messages:[id:string];task:[id:number];changed:[]}>();
const q=ref(""),enabled=ref(""),page=ref(1),expanded=ref<string>(),busy=ref<string>(),actionError=ref("");
const {data,loading,error,refresh}=useCrawlQuery<ChannelPage>(ref("/api/admin/crawl/channels"),computed(()=>({q:q.value,enabled:enabled.value,page:page.value,pageSize:20})),5000);
watch(enabled,()=>page.value=1);
const stateIcons={running:LoaderCircle,waiting:Clock,idle:CheckCircle2,paused:Pause,failed:AlertTriangle};
async function toggle(c:CrawlChannel){
 if(busy.value)return;busy.value=c.id;actionError.value="";
 try{
 const channel=(await apiFetch<{data:CrawlChannel}>("/api/admin/crawl/channels/"+encodeURIComponent(c.id))).data;
 await apiFetch("/api/admin/crawl/channels/"+encodeURIComponent(c.id),{method:"PUT",body:{id:c.id,name:channel.name||c.id,description:channel.description,enabled:!channel.enabled,transform:channel.transform??null,outbound:channel.outbound,expectedVersion:channel.version}});
 await refresh();emit("changed");
 }catch(e){actionError.value=apiErrorMessage(e);}finally{busy.value=undefined;}
}
function changed(){void refresh();emit("changed");}
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
  <p v-if="loading" role="status">正在加载频道…</p>
  <Card class="table-panel">
   <div class="channel-scroll"><table class="channel-table">
    <thead><tr><th>频道</th><th>任务状态</th><th>历史采集</th><th>日常采集</th><th>数据 / 复核</th><th>操作</th></tr></thead>
    <tbody><template v-for="c in data?.items" :key="c.id">
     <tr>
      <td class="channel-name"><strong :title="c.name||c.id">{{c.name||'@'+c.id}}</strong><small v-if="c.name&&c.name!==c.id&&c.name!=='@'+c.id">@{{c.id}}</small></td>
      <td><CrawlHint :label="channelTaskState(c).text+(c.lastError?'：'+c.lastError:'')"><span tabindex="0" class="channel-state" :class="'state-'+channelTaskState(c).state"><component :is="stateIcons[channelTaskState(c).state]" :size="15" aria-hidden="true" :class="{spinning:channelTaskState(c).state==='running'}" />{{compactChannelTaskLabel(c)}}</span></CrawlHint></td>
      <td><CrawlHint :label="'历史'+(c.historyComplete?'已补齐':'未补齐')+'，已处理 '+c.historyPages+' 页；全量采集无页数上限'"><span tabindex="0" class="history-summary"><span>{{c.historyComplete?'已补齐':!c.enabled?'未补齐':c.historyPages>0?'补齐中':'待补齐'}}</span><small>{{c.historyPages.toLocaleString('zh-CN')}} 页</small></span></CrawlHint></td>
      <td><div class="time-summary"><CrawlHint :label="'最近同步：'+crawlTime(c.lastSyncedAt)"><span tabindex="0" class="compact-value"><History :size="14" aria-hidden="true" /><time :datetime="c.lastSyncedAt||undefined">{{crawlCompactTime(c.lastSyncedAt)}}</time></span></CrawlHint><CrawlHint :label="c.enabled?'下次采集：'+crawlTime(c.nextSyncAt):'日常采集已暂停'"><span tabindex="0" class="compact-value"><Timer :size="14" aria-hidden="true" /><time v-if="c.enabled" :datetime="c.nextSyncAt">{{crawlCompactTime(c.nextSyncAt)}}</time><span v-else>暂停</span></span></CrawlHint></div></td>
      <td><div class="data-summary"><CrawlHint :label="'查看消息：'+c.messageCount+' 条消息，'+c.resourceCount+' 个资源'"><Button variant="ghost" class="stat-button tw:h-7 tw:min-h-7 tw:px-1 tw:py-0 tw:gap-1.5 tw:justify-start tw:text-xs tw:bg-transparent" @click="emit('messages',c.id)"><MessageSquare :size="14" aria-hidden="true" />{{c.messageCount.toLocaleString('zh-CN')}}<Files :size="14" aria-hidden="true" />{{c.resourceCount.toLocaleString('zh-CN')}}</Button></CrawlHint><CrawlHint :label="'待复核 '+c.failureCount+' 页，点击查看'"><Button variant="ghost" class="stat-button review-count tw:h-7 tw:min-h-7 tw:px-1 tw:py-0 tw:gap-1.5 tw:justify-start tw:text-xs tw:bg-transparent" :class="{'has-failures':c.failureCount>0}" :aria-expanded="expanded===c.id" @click="expanded=expanded===c.id?undefined:c.id"><ListChecks :size="14" aria-hidden="true" />{{c.failureCount.toLocaleString('zh-CN')}}</Button></CrawlHint></div></td>
      <td><div class="channel-actions"><Button variant="outline" :aria-expanded="expanded===c.id" @click="expanded=expanded===c.id?undefined:c.id">{{expanded===c.id?'收起':'任务'}}</Button><Button variant="outline" :disabled="!!busy" @click="toggle(c)">{{busy===c.id?'处理中…':c.enabled?'暂停':'继续'}}</Button><Button variant="ghost" @click="emit('edit',c.id)">编辑</Button></div></td>
     </tr>
     <tr v-if="expanded===c.id"><td colspan="6" class="activity-cell"><CrawlChannelActivity :channel="c.id" @task="emit('task',$event)" @changed="changed" /></td></tr>
    </template><tr v-if="data&&!data.items.length"><td colspan="6">暂无频道，新增后会自动开始采集。</td></tr></tbody>
   </table></div>
   <footer class="channel-footer"><span>共 {{data?.total||0}} 个频道</span><div class="channel-actions"><Button variant="outline" :disabled="page<=1||loading" @click="page--">上一页</Button><span>{{page}} / {{Math.max(1,Math.ceil((data?.total||0)/20))}}</span><Button variant="outline" :disabled="page*20>=(data?.total||0)||loading" @click="page++">下一页</Button></div></footer>
  </Card>
 </section>
</template>
<style scoped>
@layer components {
.crawl-channels{display:grid;gap:16px}.query-toolbar input{max-width:320px}.channel-scroll{overflow-x:auto}
.channel-table{width:100%;min-width:900px;border-collapse:collapse;text-align:left;font-size:13px}
td,th{padding:12px 14px;border-bottom:1px solid var(--border);vertical-align:middle}th{font-weight:500;color:var(--muted-foreground);white-space:nowrap}
strong{font-weight:600}small{display:block;font-size:12px;color:var(--muted-foreground);line-height:1.8}
.channel-state,.channel-actions,.channel-footer{display:flex;align-items:center;gap:8px}.channel-actions{flex-wrap:wrap}
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
.stat-button svg:nth-of-type(2){margin-left:5px}.review-count{color:var(--muted-foreground);width:fit-content}.has-failures{color:var(--destructive)}
.history-summary:focus-visible,.compact-value:focus-visible,.channel-state:focus-visible{outline:2px solid var(--ring);outline-offset:3px;border-radius:4px}
.activity-cell{padding:0}.channel-footer{padding:16px;justify-content:space-between}.spinning{animation:spin 1.5s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinning{animation:none}}
}
</style>
