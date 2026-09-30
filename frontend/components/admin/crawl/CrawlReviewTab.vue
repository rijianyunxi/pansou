<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useCrawlQuery } from "@/composables/admin/useCrawlQuery";
import {
  crawlTime,
  crawlStatus,
  type CrawlMessage,
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
const emit = defineEmits<{ message: [channel: string, id: number] }>();
const channel = ref(""),
  status = ref(""),
  cursor = ref("");
const history = ref<string[]>([]);
const params = computed(() => ({
  channel: channel.value,
  status: status.value,
  cursor: cursor.value || undefined,
  limit: 20,
}));
const { data, loading, error, refresh } = useCrawlQuery<
  CursorPage<CrawlMessage>
>(ref("/api/admin/crawl/review"), params);
watch([channel, status], () => {
  cursor.value = "";
  history.value = [];
});
function next() {
  if (!data.value?.nextCursor) return;
  history.value.push(cursor.value);
  cursor.value = data.value.nextCursor;
}
function previous() {
  const p = history.value.pop();
  cursor.value = p || "";
}
defineExpose({ refresh });
</script>
<template>
  <div class="crawl-review">
    <div class="query-toolbar">
      <Input
        v-model="channel"
        placeholder="按频道 username 筛选"
        aria-label="复核频道"
      /><AdminSelect v-model="status" aria-label="复核原因"
        ><option value="">全部问题</option>
        <option value="failed">解析失败</option>
        <option value="review">需要复核</option></AdminSelect
      ><Button variant="outline" @click="refresh">刷新</Button>
    </div>
    <p class="review-note">
      修复流程：查看原文与错误 → 调整频道 DSL → 预览 →
      明确重解析。这里不会直接批准不明确的聚合资源。
    </p>
    <p v-if="error" role="alert" class="form-error">{{ error }}</p>
    <p v-if="loading" role="status" class="admin-loading">
      正在加载待复核消息…
    </p>
    <Card class="table-panel"
      ><Table class="crawl-review-table"
        ><TableHeader
          ><TableRow
            ><TableHead>频道 / 消息</TableHead><TableHead>摘要</TableHead
            ><TableHead>问题</TableHead><TableHead>发布时间</TableHead
            ><TableHead>操作</TableHead></TableRow
          ></TableHeader
        ><TableBody
          ><TableRow
            v-for="m in data?.items"
            :key="m.channelId + ':' + m.messageId"
            ><TableCell
              >@{{ m.channelId }}
              <p>#{{ m.messageId }}</p></TableCell
            ><TableCell
              ><p class="review-summary">{{ m.summary }}</p></TableCell
            ><TableCell
              >{{ crawlStatus(m.status) }}
              <p class="review-summary">
                {{ m.parseError || "需调整资源边界" }}
              </p></TableCell
            ><TableCell>{{ crawlTime(m.publishedAt) }}</TableCell
            ><TableCell
              ><Button
                variant="outline"
                size="sm"
                @click="emit('message', m.channelId, m.messageId)"
                >查看消息</Button
              ></TableCell
            ></TableRow
          ><TableRow v-if="!loading && !data?.items.length"
            ><TableCell colspan="5">没有待处理的解析异常。</TableCell></TableRow
          ></TableBody
        ></Table
      >
      <footer class="table-footer">
        <span>按发布时间倒序 · 频道 / 消息稳定分页</span>
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
  .crawl-review {
    display: grid;
    gap: 16px;
  }
  .crawl-review .query-toolbar input {
    max-width: 240px;
  }
  .crawl-review .query-toolbar .admin-select-trigger {
    max-width: 180px;
  }
  .review-note {
    font-size: 12px;
    line-height: 1.7;
    color: var(--muted-foreground);
  }
  .crawl-review-table {
    min-width: 850px;
  }
  .review-summary {
    max-width: 260px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-size: 12px;
    color: var(--muted-foreground);
  }
  .table-footer > div {
    display: flex;
    gap: 8px;
  }
}
</style>
