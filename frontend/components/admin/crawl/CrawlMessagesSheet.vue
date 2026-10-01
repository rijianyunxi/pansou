<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useCrawlQuery } from "@/composables/admin/useCrawlQuery";
import {
  crawlTime,
  crawlFilterDate,
  crawlStatus,
  type CrawlMessage,
  type CursorPage,
} from "@/types/crawl";
import AdminDialog from "../AdminDialog.vue";
import AdminSelect from "../AdminSelect.vue";
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
const props = defineProps<{ channel: string; initialMessage?: number }>();
const emit = defineEmits<{ close: [] }>();
const selected = ref<number | null>(props.initialMessage || null),
  status = ref(""),
  from = ref(""),
  to = ref(""),
  cursor = ref(""),
  history = ref<string[]>([]),
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
  cursor: cursor.value || undefined,
  limit: 20,
}));
const { data, loading, error, refresh } = useCrawlQuery<
  CursorPage<CrawlMessage>
>(url, params, 0);
watch([status, from, to], () => {
  cursor.value = "";
  history.value = [];
});
function next() {
  if (!data.value?.nextCursor) return;
  history.value.push(cursor.value);
  cursor.value = data.value.nextCursor;
}
function previous() {
  cursor.value = history.value.pop() || "";
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
          <p v-if="loading" role="status">正在加载消息…</p>
          <p v-if="error" role="alert" class="form-error">{{ error }}</p>
          <Table class="messages-table"
            ><TableHeader
              ><TableRow
                ><TableHead>消息 / 发布时间</TableHead
                ><TableHead>状态</TableHead
                ><TableHead>操作</TableHead></TableRow
              ></TableHeader
            ><TableBody
              ><TableRow v-for="m in data?.items" :key="m.messageId"
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
                ><TableCell colspan="3">没有匹配的消息。</TableCell></TableRow
              ></TableBody
            ></Table
          >
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
        <template v-if="selected === null"
          ><Button
            variant="outline"
            :disabled="!history.length || loading"
            @click="previous"
            >上一批</Button
          ><Button
            variant="outline"
            :disabled="!data?.hasMore || loading"
            @click="next"
            >下一批</Button
          ></template
        ><Button variant="outline" @click="emit('close')">关闭</Button>
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
  .messages-table p {
    font-size: 12px;
    color: var(--muted-foreground);
  }
}
</style>
