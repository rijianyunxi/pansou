<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useCrawlQuery } from "@/composables/admin/useCrawlQuery";
import { useAdminConfirm } from "@/composables/admin/useAdminConfirm";
import { apiFetch, apiErrorMessage } from "@/src/appRuntime";
import {
  crawlTime,
  crawlFilterDate,
  crawlStatus,
  type MessagePage,
} from "@/types/crawl";
import AdminDialog from "../AdminDialog.vue";
import AdminSelect from "../AdminSelect.vue";
import AdminPagination from "../AdminPagination.vue";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "../ui/table";
import CrawlMessageDetail from "./CrawlMessageDetail.vue";
const props = defineProps<{ channel: string; initialMessage?: number; initialStatus?: string }>();
const emit = defineEmits<{ close: []; changed: [] }>();
const { confirm } = useAdminConfirm();
const selected = ref<number | null>(props.initialMessage || null),
  status = ref(props.initialStatus || ""),
  from = ref(""),
  to = ref(""),
  page = ref(1),
  pageSize = ref(20),
  selectedIds = ref<number[]>([]),
  actionBusy = ref(false),
  actionError = ref(""),
  notice = ref(""),
  scrollRegion = ref<HTMLElement>(),
  scroll = ref(0);
const url = computed(
  () =>
    "/api/admin/crawl/channels/" +
    encodeURIComponent(props.channel) +
    "/messages",
);
const params = computed(() => ({
  status: status.value,
  from: crawlFilterDate(from.value),
  to: crawlFilterDate(to.value),
  page: page.value,
  pageSize: pageSize.value,
}));
const { data, loading, error, refresh } = useCrawlQuery<MessagePage>(url, params, 0);
const pageCount = computed(() =>
  Math.max(1, Math.ceil((data.value?.total || 0) / pageSize.value)),
);
const selectable = computed(() => status.value === "failed");
const allSelected = computed({
  get: () =>
    (data.value?.items.length ?? 0) > 0 &&
    data.value!.items.every((m) => selectedIds.value.includes(m.messageId)),
  set: (value: boolean) => {
    selectedIds.value = value ? data.value!.items.map((m) => m.messageId) : [];
  },
});
watch([status, from, to], () => {
  page.value = 1;
  selectedIds.value = [];
  notice.value = "";
});
async function bulk(action: "retry" | "ignore") {
  if (actionBusy.value || !selectedIds.value.length) return;
  if (
    action === "ignore" &&
    !(await confirm(
      `放弃所选 ${selectedIds.value.length} 条失败消息？记录会删除，缺失数据不会补齐。`,
    ))
  )
    return;
  actionBusy.value = true;
  actionError.value = "";
  notice.value = "";
  try {
    const r = await apiFetch<{ data: { affected: number; jobs: number } }>(
      url.value + "/action",
      { method: "POST", body: { action, ids: selectedIds.value } },
    );
    notice.value =
      action === "ignore"
        ? `已忽略 ${r.data.affected} 条失败消息`
        : `已创建 ${r.data.jobs} 个重抓任务，解析结果稍后回流水`;
    selectedIds.value = [];
    await refresh();
    emit("changed");
  } catch (e) {
    actionError.value = apiErrorMessage(e);
  } finally {
    actionBusy.value = false;
  }
}
function goToPage(next: number) {
  if (next < 1 || next > pageCount.value || next === page.value) return;
  page.value = next;
}
function changePageSize(size: number) {
  pageSize.value = size;
  page.value = 1;
}
function open(id: number) {
  scroll.value = scrollRegion.value?.scrollTop || 0;
  selected.value = id;
  if (scrollRegion.value) scrollRegion.value.scrollTop = 0;
}
async function back() {
  selected.value = null;
  await nextTick();
  if (scrollRegion.value) scrollRegion.value.scrollTop = scroll.value;
}
</script>
<template>
  <AdminDialog
    :title="'@' + channel + ' 的消息'"
    description="查看消息解析状态与已存资源，不保存或展示消息原文。"
    drawer
    wide
    @close="emit('close')"
    ><section class="admin-dialog-form">
      <div ref="scrollRegion" class="admin-form-fields">
        <div v-show="selected === null" class="messages-list">
          <div class="query-toolbar">
            <AdminSelect v-model="status" aria-label="消息解析状态"
              ><option value="">全部消息</option>
              <option value="parsed">已解析</option>
              <option value="empty">无资源</option>
              <option value="failed">解析失败</option>
</AdminSelect
            ><Button variant="outline" @click="refresh">刷新消息</Button>
          </div>
          <div class="query-toolbar">
            <label
              >发布时间起<Input
                v-model="from"
                type="datetime-local"
                class="message-date" /></label
            ><label
              >发布时间止<Input
                v-model="to"
                type="datetime-local"
                class="message-date"
            /></label>
          </div>
          <p v-if="data" class="message-total">
            当前筛选 {{ data.total.toLocaleString("zh-CN") }} 条 · 已解析
            {{ data.counts.parsed.toLocaleString("zh-CN") }} · 无资源
            {{ data.counts.empty.toLocaleString("zh-CN") }} · 解析失败
            {{ data.counts.failed.toLocaleString("zh-CN") }}
          </p>
          <div v-if="selectable" class="query-toolbar">
            <span class="message-total">已选 {{ selectedIds.length }} 条</span>
            <Button
              variant="outline"
              :disabled="actionBusy || !selectedIds.length"
              @click="bulk('retry')"
              >重试</Button
            ><Button
              variant="outline"
              :disabled="actionBusy || !selectedIds.length"
              @click="bulk('ignore')"
              >忽略</Button
            >
          </div>
          <p v-if="actionError" role="alert" class="form-error">{{ actionError }}</p>
          <p v-if="notice" role="status" class="message-total">{{ notice }}</p>
          <p v-if="loading" role="status">正在加载消息…</p>
          <p v-if="error" role="alert" class="form-error">{{ error }}</p>
          <Table class="messages-table"
            ><TableHeader
              ><TableRow
                ><TableHead v-if="selectable" class="w-10"
                  ><input
                    v-model="allSelected"
                    type="checkbox"
                    :disabled="!data?.items.length"
                    aria-label="选择本页全部失败消息" /></TableHead
                ><TableHead>消息 / 发布时间</TableHead
                ><TableHead>状态</TableHead
                ><TableHead>操作</TableHead></TableRow
              ></TableHeader
            ><TableBody
              ><TableRow v-for="m in data?.items" :key="m.messageId"
                ><TableCell v-if="selectable"
                  ><input
                    v-model="selectedIds"
                    type="checkbox"
                    :value="m.messageId"
                    :aria-label="'选择失败消息 ' + m.messageId" /></TableCell
                ><TableCell
                  >#{{ m.messageId }}
                  <p>{{ crawlTime(m.publishedAt) }}</p></TableCell
                ><TableCell>{{ crawlStatus(m.status) }}</TableCell
                ><TableCell
                  ><Button
                    variant="outline"
                    size="sm"
                    @click="open(m.messageId)"
                    >查看详情</Button
                  ></TableCell
                ></TableRow
              ><TableRow v-if="!loading && !error && !data?.items.length"
                ><TableCell :colspan="selectable ? 4 : 3">没有匹配的消息。</TableCell></TableRow
              ></TableBody
            ></Table
          >
          <AdminPagination
            :page="page"
            :total-pages="pageCount"
            :total="data?.total || 0"
            :page-size="pageSize"
            @change="goToPage"
            @update:page-size="changePageSize"
          />
        </div>
        <CrawlMessageDetail
          v-if="selected !== null"
          :key="channel + selected"
          :channel="channel"
          :id="selected"
          @back="back"
        />
      </div>
      <footer class="modal-actions">
        <Button variant="outline" @click="emit('close')">关闭</Button>
      </footer>
    </section></AdminDialog
  >
</template>
<style scoped>
@layer components {
  .messages-list {
    display: grid;
    gap: 16px;
    min-width: 0;
  }
  .messages-list .admin-select-trigger {
    max-width: 200px;
  }
  .messages-table {
    min-width: 440px;
  }
  .message-total {
    font-size: 12px;
    color: var(--muted-foreground);
    font-variant-numeric: tabular-nums;
  }
  .messages-table p {
    font-size: 12px;
    color: var(--muted-foreground);
  }
}
</style>
