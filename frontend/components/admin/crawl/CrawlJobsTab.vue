<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useCrawlQuery } from "@/composables/admin/useCrawlQuery";
import {
  crawlTime,
  crawlFilterDate,
  crawlStatus,
  crawlKind,
  crawlReason,
  type CrawlJob,
  type CursorPage,
} from "@/types/crawl";
import AdminSelect from "../AdminSelect.vue";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Card } from "../ui/card";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "../ui/table";
const emit = defineEmits<{ task: [id: number] }>();
const route = useRoute(),
  router = useRouter();
const channel = ref(String(route.query.channel || "")),
  status = ref(String(route.query.status || "")),
  kind = ref(String(route.query.kind || "")),
  from = ref(String(route.query.from || "")),
  to = ref(String(route.query.to || "")),
  cursor = ref(String(route.query.cursor || ""));
const history = ref<string[]>([]);
const params = computed(() => ({
  channel: channel.value,
  status: status.value,
  kind: kind.value,
  from: crawlFilterDate(from.value),
  to: crawlFilterDate(to.value),
  cursor: cursor.value || undefined,
  limit: 20,
}));
const { data, loading, error, refresh } = useCrawlQuery<CursorPage<CrawlJob>>(
  ref("/api/admin/crawl/jobs"),
  params,
);
watch([channel, status, kind, from, to], () => {
  cursor.value = "";
  history.value = [];
});
watch(
  params,
  () =>
    void router.replace({
      query: {
        ...route.query,
        channel: channel.value || undefined,
        status: status.value || undefined,
        kind: kind.value || undefined,
        from: from.value || undefined,
        to: to.value || undefined,
        cursor: cursor.value || undefined,
      },
    }),
);
function next() {
  if (!data.value?.nextCursor) return;
  history.value.push(cursor.value);
  cursor.value = data.value.nextCursor;
}
function previous() {
  cursor.value = history.value.pop() || "";
}
defineExpose({ refresh });
</script>
<template>
  <div class="crawl-jobs">
    <div class="query-toolbar">
      <Input
        v-model="channel"
        aria-label="任务频道"
        placeholder="按频道 username 筛选"
      /><AdminSelect v-model="status" aria-label="任务状态"
        ><option value="">全部状态</option>
        <option value="queued">排队</option>
        <option value="running">执行中</option>
        <option value="paused">暂停</option>
        <option value="failed">失败</option>
        <option value="completed">完成</option>
        <option value="cancelled">已取消</option></AdminSelect
      ><AdminSelect v-model="kind" aria-label="任务类型"
        ><option value="">全部类型</option>
        <option value="sync">增量同步</option>
        <option value="backfill">历史回填</option>
        <option value="review">近期编辑复查</option>
        <option value="reparse">重解析原文</option>
        <option value="reparse_message">单条重解析</option></AdminSelect
      ><Button variant="outline" @click="refresh">刷新任务</Button>
    </div>
    <div class="query-toolbar">
      <label class="job-date"
        >创建时间起<Input
          v-model="from"
          type="datetime-local"
          aria-label="任务创建时间起" /></label
      ><label class="job-date"
        >创建时间止<Input
          v-model="to"
          type="datetime-local"
          aria-label="任务创建时间止" /></label
      ><Button
        variant="ghost"
        :disabled="!from && !to"
        @click="
          from = '';
          to = '';
        "
        >清空时间</Button
      >
    </div>
    <p v-if="error" role="alert" class="form-error">{{ error }}</p>
    <p v-if="loading" role="status" class="admin-loading">正在加载任务…</p>
    <Card class="table-panel"
      ><Table class="crawl-jobs-table"
        ><TableHeader
          ><TableRow
            ><TableHead>任务</TableHead><TableHead>频道</TableHead
            ><TableHead>状态</TableHead><TableHead>处理计数</TableHead
            ><TableHead>更新时间</TableHead
            ><TableHead>结果 / 操作</TableHead></TableRow
          ></TableHeader
        ><TableBody
          ><TableRow v-for="j in data?.items" :key="j.id"
            ><TableCell
              ><Button variant="ghost" size="sm" @click="emit('task', j.id)"
                >#{{ j.id }} {{ crawlKind(j.kind) }}</Button
              ></TableCell
            ><TableCell>@{{ j.channelId }}</TableCell
            ><TableCell>{{ crawlStatus(j.status) }}</TableCell
            ><TableCell
              ><p>
                {{ j.pages }} {{ j.kind.startsWith("reparse") ? "批" : "页" }} /
                {{ j.messages }} 条消息
              </p>
              <p>
                {{ j.resources }} 次资源写入 · {{ j.failures }} 次解析异常
              </p></TableCell
            ><TableCell>{{ crawlTime(j.updatedAt) }}</TableCell
            ><TableCell
              ><p class="job-result" :title="j.lastError || ''">
                {{ j.lastError || crawlReason(j.stopReason) }}
              </p>
              <Button variant="outline" size="sm" @click="emit('task', j.id)"
                >查看任务</Button
              ></TableCell
            ></TableRow
          ><TableRow v-if="!loading && !data?.items.length"
            ><TableCell colspan="6">没有匹配的任务。</TableCell></TableRow
          ></TableBody
        ></Table
      >
      <footer class="table-footer">
        <span>按任务 ID 倒序 · 取消任务不会暂停频道的后续调度</span>
        <div>
          <Button
            variant="outline"
            size="sm"
            :disabled="!history.length || loading"
            @click="previous"
            >上一批</Button
          ><Button
            variant="outline"
            size="sm"
            :disabled="!data?.hasMore || loading"
            @click="next"
            >下一批</Button
          >
        </div>
      </footer></Card
    >
  </div>
</template>
<style scoped>
@layer components {
  .job-date {
    display: grid;
    gap: 6px;
    font-size: 12px;
    color: var(--muted-foreground);
    min-width: 0;
  }
  .job-date input {
    max-width: 240px;
  }
  .crawl-jobs {
    display: grid;
    gap: 16px;
  }
  .crawl-jobs .query-toolbar input {
    max-width: 240px;
  }
  .crawl-jobs .query-toolbar .admin-select-trigger {
    max-width: 180px;
  }
  .crawl-jobs-table {
    min-width: 1050px;
  }
  .crawl-jobs-table p {
    font-size: 12px;
    color: var(--muted-foreground);
  }
  .job-result {
    max-width: 200px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .table-footer > div {
    display: flex;
    gap: 8px;
  }
}
</style>
