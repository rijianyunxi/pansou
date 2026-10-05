<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RotateCcw, CircleCheck, LoaderCircle } from "@lucide/vue";
import { useCrawlQuery } from "@/composables/admin/useCrawlQuery";
import { useAdminConfirm } from "@/composables/admin/useAdminConfirm";
import { apiFetch, apiErrorMessage } from "@/src/appRuntime";
import { crawlTime, crawlStatus, type MessagePage } from "@/types/crawl";
import AdminDialog from "../AdminDialog.vue";
import AdminCheckbox from "../AdminCheckbox.vue";
import AdminPagination from "../AdminPagination.vue";
import ResourceDetailDrawer from "../ResourceDetailDrawer.vue";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";
import { Button } from "../ui/button";
import AdminStatusBadge from "../AdminStatusBadge.vue";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../ui/table";
const props = defineProps<{ channel: string; initialStatus?: string; scope?: "all" | "today" }>();
const emit = defineEmits<{ close: []; changed: [] }>();
const { confirm } = useAdminConfirm();
const status = ref(props.initialStatus || "all"), page = ref(1), pageSize = ref(20);
const selectedIds = ref<number[]>([]), actionBusy = ref<"retry" | "ignore" | null>(null);
const actionError = ref(""), notice = ref(""), resourceId = ref<string>();
const url = computed(() => "/api/admin/crawl/channels/" + encodeURIComponent(props.channel) + "/messages");
const params = computed(() => ({ status: status.value, scope: props.scope || "all", page: page.value, pageSize: pageSize.value }));
const { data, loading, error, refresh } = useCrawlQuery<MessagePage>(url, params, 5000);
const pageCount = computed(() => Math.max(1, Math.ceil((data.value?.total || 0) / pageSize.value)));
const selectable = computed(() => status.value === "failed");
const allSelected = computed({
  get: () => !!data.value?.items.length && data.value.items.every(m => selectedIds.value.includes(m.messageId)),
  set: (checked: boolean) => { selectedIds.value = checked ? (data.value?.items.map(m => m.messageId) || []) : []; },
});
const someSelected = computed(() => selectedIds.value.length > 0 && !allSelected.value);
watch([status, () => props.scope], () => { page.value = 1; selectedIds.value = []; notice.value = ""; });
watch([page, pageSize], () => { selectedIds.value = []; });
watch(data, result => {
  if (result) {
    selectedIds.value = selectedIds.value.filter(id => result.items.some(m => m.messageId === id && m.status === "failed"));
    if (page.value > pageCount.value) page.value = pageCount.value;
  }
});
async function bulk(action: "retry" | "ignore") {
  if (actionBusy.value || !selectedIds.value.length) return;
  const ids = [...selectedIds.value];
  if (action === "ignore" && !(await confirm(`忽略所选 ${ids.length} 条失败任务？将直接删除任务记录，缺失数据不会补齐。`))) return;
  actionBusy.value = action; actionError.value = ""; notice.value = "";
  try {
    const result = await apiFetch<{ data: { affected: number; jobs: number } }>(url.value + "/action", { method: "POST", body: { action, ids } });
    notice.value = action === "ignore" ? `已删除 ${result.data.affected} 条任务记录` : `已提交 ${result.data.affected} 条任务重试`;
    selectedIds.value = []; await refresh(); emit("changed");
  } catch (e) { actionError.value = apiErrorMessage(e); }
  finally { actionBusy.value = null; }
}
function goToPage(next: number) { if (next >= 1 && next <= pageCount.value) page.value = next; }
function changePageSize(size: number) { pageSize.value = size; page.value = 1; }
</script>
<template>
  <AdminDialog :title="'@' + channel + (scope === 'today' ? ' 的今日采集' : ' 的采集记录')" drawer wide @close="emit('close')">
    <section class="task-drawer">
      <div class="task-toolbar">
        <p v-if="scope === 'today'" class="task-scope-note">按北京时间处理日期统计，包含当天补采的历史消息；成功含已解析和无资源记录。</p>
        <Tabs v-model="status" aria-label="任务状态">
          <TabsList>
            <TabsTrigger value="all">全部<span v-if="data" class="tab-count">{{ data.counts.all.toLocaleString('zh-CN') }}</span></TabsTrigger>
            <TabsTrigger value="success">成功<span v-if="data" class="tab-count">{{ data.counts.success.toLocaleString('zh-CN') }}</span></TabsTrigger>
            <TabsTrigger value="failed">失败<span v-if="data" class="tab-count">{{ data.counts.failed.toLocaleString('zh-CN') }}</span></TabsTrigger>
          </TabsList>
        </Tabs>
        <div v-if="selectable" class="task-actions">
          <span class="selection-count">已选 {{ selectedIds.length }} 条</span>
          <Button size="sm" :disabled="!!actionBusy || !selectedIds.length" @click="bulk('retry')"><LoaderCircle v-if="actionBusy === 'retry'" class="tw:animate-spin" /><RotateCcw v-else />重试</Button>
          <Button size="sm" variant="outline" :disabled="!!actionBusy || !selectedIds.length" @click="bulk('ignore')"><LoaderCircle v-if="actionBusy === 'ignore'" class="tw:animate-spin" /><CircleCheck v-else />忽略</Button>
        </div>
      </div>
      <p v-if="actionError || error" role="alert" class="task-feedback form-error">{{ actionError || error }}</p>
      <p v-if="notice" role="status" class="task-feedback">{{ notice }}</p>
      <div class="task-scroll">
        <Table class="tasks-table">
          <TableHeader><TableRow>
            <TableHead v-if="selectable" class="selection-col"><div class="task-selection"><AdminCheckbox v-model="allSelected" :indeterminate="someSelected" :disabled="!data?.items.length || !!actionBusy" aria-label="选择本页全部失败任务" /></div></TableHead>
            <TableHead class="task-time-col">消息 / 任务时间</TableHead><TableHead class="task-state-col">状态</TableHead><TableHead>摘要</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            <TableRow v-for="task in data?.items" :key="task.messageId" :data-state="selectedIds.includes(task.messageId) ? 'selected' : undefined">
              <TableCell v-if="selectable" class="selection-col"><div class="task-selection"><AdminCheckbox v-model="selectedIds" :value="task.messageId" :disabled="!!actionBusy" :aria-label="'选择失败任务 ' + task.messageId" /></div></TableCell>
              <TableCell class="task-time"><span class="task-id">#{{ task.messageId }}</span><time :datetime="task.taskAt">{{ crawlTime(task.taskAt) }}</time></TableCell>
              <TableCell><AdminStatusBadge :state="task.status">{{ crawlStatus(task.status) }}</AdminStatusBadge></TableCell>
              <TableCell class="task-summary">
                <p v-if="task.status === 'failed'" class="failure-reason">{{ task.errorMessage || '解析失败' }}</p>
                <ul v-else-if="task.resources.length" class="resource-names"><li v-for="resource in task.resources" :key="resource.id"><Button variant="link" class="resource-name tw:h-auto tw:p-0 tw:text-left tw:whitespace-normal tw:justify-start" @click="resourceId = resource.id">{{ resource.name }}</Button></li></ul>
                <span v-else class="summary-empty">{{ task.status === 'empty' ? '未识别到资源' : '资源已删除' }}</span>
              </TableCell>
            </TableRow>
            <TableRow v-if="loading || (!error && !data?.items.length)"><TableCell :colspan="selectable ? 4 : 3" class="task-empty">{{ loading ? '正在加载任务…' : '没有匹配的任务' }}</TableCell></TableRow>
          </TableBody>
        </Table>
      </div>
      <AdminPagination :page="page" :total-pages="pageCount" :total="data?.total || 0" :page-size="pageSize" :disabled="loading || !!actionBusy" @change="goToPage" @update:page-size="changePageSize" />
    </section>
  </AdminDialog>
  <ResourceDetailDrawer v-if="resourceId" :key="resourceId" :id="resourceId" @close="resourceId = undefined" />
</template>
<style scoped>
@layer components {
.task-scope-note{flex-basis:100%;margin:0;font-size:12px;line-height:1.6;color:var(--muted-foreground)}
.task-drawer{display:flex;flex-direction:column;min-height:0;height:100%}.task-toolbar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:20px 24px;border-bottom:1px solid var(--border)}
.tab-count{color:var(--muted-foreground);font-size:12px;font-variant-numeric:tabular-nums}.task-actions{display:flex;align-items:center;gap:8px}.selection-count{margin-right:4px;font-size:12px;color:var(--muted-foreground)}
.task-feedback{margin:0;padding:12px 24px;font-size:13px}.task-scroll{flex:1;min-height:0;overflow:auto}
.task-scroll :deep(.tasks-table){table-layout:fixed;min-width:560px}
.task-scroll :deep([data-slot="table-head"]){padding:0 16px}
.task-scroll :deep([data-slot="table-cell"]){padding:12px 16px}
.task-scroll :deep(.selection-col){width:56px;padding-left:20px;padding-right:16px}
.task-time-col{width:212px}.task-state-col{width:104px}
.task-selection{display:flex;align-items:center;justify-content:center}
.task-scroll :deep([data-slot="table-row"][data-state="selected"]){background:var(--muted)}
.task-id{font-weight:500;font-variant-numeric:tabular-nums}.task-time time{display:block;margin-top:4px;color:var(--muted-foreground);font-size:12px;font-variant-numeric:tabular-nums}
.task-scroll :deep(.task-summary){white-space:normal;overflow-wrap:anywhere}
.failure-reason{margin:0;font-size:13px;line-height:1.6;color:var(--foreground)}.resource-names{display:grid;gap:6px;list-style:none;padding:0;margin:0}.resource-name{font-size:13px;line-height:1.6;max-width:100%;overflow-wrap:anywhere}.summary-empty{color:var(--muted-foreground);font-size:13px}.task-scroll :deep(.task-empty){text-align:center;color:var(--muted-foreground);padding:40px 24px}
@media(max-width:640px){.task-toolbar{padding:16px}.task-actions{width:100%;justify-content:flex-end}.task-time-col{width:185px}.task-state-col{width:95px}}
@media(prefers-reduced-motion:reduce){.task-actions :deep(.tw\:animate-spin){animation:none}}
}
</style>
