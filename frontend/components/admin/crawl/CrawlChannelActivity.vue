<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useCrawlQuery } from "@/composables/admin/useCrawlQuery";
import { useAdminConfirm } from "@/composables/admin/useAdminConfirm";
import { apiFetch, apiErrorMessage } from "@/src/appRuntime";
import { crawlKind, crawlStatus, crawlTime, type CrawlJob, type CrawlPageFailure, type CursorPage } from "@/types/crawl";
import { Button } from "../ui/button";
const props=defineProps<{channel:string}>();
const emit=defineEmits<{task:[id:number];changed:[]}>();
const {confirm}=useAdminConfirm();
const selected=ref<number[]>([]), busy=ref(false), actionError=ref(""), notice=ref(""), before=ref<number|undefined>();
const failureUrl=computed(()=>"/api/admin/crawl/channels/"+encodeURIComponent(props.channel)+"/failures");
const {data:failures,error:failureError,refresh:refreshFailures}=useCrawlQuery<{items:CrawlPageFailure[];hasMore:boolean;nextBefore:number}>(failureUrl,computed(()=>({before:before.value})),5000);
const {data:jobs,error:jobError,refresh:refreshJobs}=useCrawlQuery<CursorPage<CrawlJob>>(ref("/api/admin/crawl/jobs"),computed(()=>({channel:props.channel,limit:10})),5000);
const available=computed(()=>failures.value?.items.filter(f=>!["queued","running","paused"].includes(f.retryStatus||""))||[]);
const all=computed({get:()=>available.value.length>0 && available.value.every(f=>selected.value.includes(f.id)),set:(value:boolean)=>{selected.value=value?available.value.map(f=>f.id):[];}});
watch(failures,()=>{selected.value=selected.value.filter(id=>available.value.some(f=>f.id===id));});
async function action(kind:"retry"|"ignore"){
 if(busy.value || !selected.value.length)return;
 if(kind==="ignore" && !await confirm("删除所选 "+selected.value.length+" 条待复核记录？缺失数据不会因此补齐，已入库资源不会删除。"))return;
 busy.value=true;actionError.value="";notice.value="";
 try{const r=await apiFetch<{data:{affected:number}}>(failureUrl.value,{method:"POST",body:{action:kind,ids:selected.value}});
 notice.value=kind==="retry"?"已排队重抓 "+r.data.affected+" 页":"已删除 "+r.data.affected+" 条待复核记录";
 selected.value=[];await Promise.all([refreshFailures(),refreshJobs()]);emit("changed");
 }catch(e){actionError.value=apiErrorMessage(e);}finally{busy.value=false;}
}
</script>
<template>
 <section class="channel-activity" :aria-label="'@'+channel+' 的任务与待复核'">
  <h3>频道任务</h3>
  <p v-if="jobError" role="alert" class="form-error">{{jobError}}</p>
  <div class="task-list">
   <Button v-for="j in jobs?.items" :key="j.id" variant="outline" @click="emit('task',j.id)">
    #{{j.id}} · {{crawlKind(j.kind)}} · {{crawlStatus(j.status)}} · {{j.pages}} 页
   </Button>
   <span v-if="jobs && !jobs.items.length">首次任务等待自动调度</span>
  </div>
  <div class="failure-heading"><h3>待复核 · 失败页</h3><span>已选 {{selected.length}} 页</span>
   <Button :disabled="busy||!selected.length" @click="action('retry')">{{busy?'处理中…':'一键重试'}}</Button>
   <Button variant="outline" :disabled="busy||!selected.length" @click="action('ignore')">一键忽略</Button>
  </div>
  <p v-if="failureError||actionError" role="alert" class="form-error">{{failureError||actionError}}</p>
  <p v-if="notice" role="status">{{notice}}</p>
  <p class="help">重试会重新请求相同游标的一页并解析入库；忽略只删除勾选记录，不标记历史完成。</p>
  <div class="failure-scroll">
   <table v-if="failures?.items.length">
    <thead><tr><th><input v-model="all" type="checkbox" :disabled="busy||!available.length" aria-label="选择本批全部可操作失败页" /></th><th>任务 / 页</th><th>请求游标</th><th>失败原因</th><th>状态 / 时间</th></tr></thead>
    <tbody><tr v-for="f in failures.items" :key="f.id">
     <td><input v-model="selected" type="checkbox" :value="f.id" :disabled="busy||!available.some(a=>a.id===f.id)" :aria-label="'选择失败页 '+f.id" /></td>
     <td>{{crawlKind(f.kind)}} · {{f.pageNumber==null?"消息定位页":"第 "+f.pageNumber+" 页"}}</td>
     <td>{{f.cursorBefore==null?'最新页':'before='+f.cursorBefore}}</td>
     <td class="error-cell">{{f.lastError}}</td>
     <td>{{f.retryStatus&&['queued','running','paused'].includes(f.retryStatus)?'重试'+crawlStatus(f.retryStatus):'待复核'}}<small>{{crawlTime(f.createdAt)}}</small></td>
    </tr></tbody>
   </table><p v-else>暂无待复核失败页</p>
  </div>
  <div v-if="before||failures?.hasMore" class="task-list">
   <Button v-if="before" variant="outline" :disabled="busy" @click="before=undefined;selected=[]">返回首批</Button>
   <Button v-if="failures?.hasMore" variant="outline" :disabled="busy" @click="before=failures?.nextBefore;selected=[]">下一批失败页</Button>
  </div>
 </section>
</template>
<style scoped>
@layer components {
.channel-activity{padding:20px;background:var(--muted);display:grid;gap:14px}
h3{font-size:14px;font-weight:600}.task-list,.failure-heading{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.failure-heading>span,.help,small{color:var(--muted-foreground);font-size:12px}
.help{line-height:1.7}.failure-scroll{overflow-x:auto}table{width:100%;font-size:13px;border-collapse:collapse;text-align:left}
td,th{padding:12px 8px;border-bottom:1px solid var(--border);vertical-align:top}.error-cell{max-width:420px;overflow-wrap:anywhere;white-space:normal}
small{display:block}input[type=checkbox]{width:20px;height:20px;cursor:pointer}
}
</style>
