<script setup lang="ts">
import { computed, ref } from "vue";
import { useCrawlQuery } from "@/composables/admin/useCrawlQuery";
import { useAdminConfirm } from "@/composables/admin/useAdminConfirm";
import { apiFetch, apiErrorMessage } from "@/src/appRuntime";
import {
  crawlTime,
  crawlStatus,
  crawlKind,
  crawlReason,
  type CrawlJob,
} from "@/types/crawl";
import AdminDialog from "../AdminDialog.vue";
import { Button } from "../ui/button";
const props = defineProps<{ id: number }>();
const emit = defineEmits<{ close: []; changed: [] }>();
const { confirm } = useAdminConfirm();
const url = computed(() => "/api/admin/crawl/jobs/" + props.id);
const { data, loading, error, refresh } = useCrawlQuery<CrawlJob>(
  url,
  ref({}),
  5000,
);
const pending = ref(false),
  actionError = ref("");
async function action(kind: "cancel" | "retry") {
  if (pending.value) return;
  if (
    !(await confirm(
      kind === "cancel"
        ? "取消本次任务？频道自动调度仍可能创建后续任务。"
        : "将失败任务重新排队？不会立即保证采集成功。",
    ))
  )
    return;
  pending.value = true;
  actionError.value = "";
  try {
    await apiFetch(url.value + "/" + kind, { method: "POST" });
    await refresh();
    emit("changed");
  } catch (e) {
    actionError.value = apiErrorMessage(e);
  } finally {
    pending.value = false;
  }
}
</script>
<template>
  <AdminDialog
    :title="'任务 #' + id"
    description="实际处理计数不是频道完整历史百分比。"
    drawer
    :busy="pending"
    @close="emit('close')"
    ><section class="job-detail">
      <p v-if="loading" role="status">正在加载任务详情…</p>
      <p v-if="error" role="alert" class="form-error">
        {{ error }}<Button variant="outline" @click="refresh">重试</Button>
      </p>
      <template v-if="data"
        ><div class="job-detail-heading">
          <strong
            >{{ crawlKind(data.kind) }} · {{ crawlStatus(data.status) }}</strong
          ><span>@{{ data.channelId }}</span>
        </div>
        <dl>
          <dt>创建</dt>
          <dd>{{ crawlTime(data.createdAt) }}</dd>
          <dt>更新</dt>
          <dd>{{ crawlTime(data.updatedAt) }}</dd>
          <dt>完成</dt>
          <dd>{{ crawlTime(data.completedAt) }}</dd>
          <dt>处理计数</dt>
          <dd>
            {{ data.pages }}
            页 ·
            {{ data.messages }} 消息 · {{ data.resources }} 次资源写入
          </dd>
          <dt>解析异常</dt>
          <dd>{{ data.failures }}</dd>
          <dt>检查点</dt>
          <dd>{{ data.cursorBefore || "—" }}</dd>
          <dt>终止原因</dt>
          <dd>{{ crawlReason(data.stopReason) }}</dd>
        </dl>
        <p v-if="data.lastError" role="alert" class="form-error">
          {{ data.lastError }}
        </p>
        <details>
          <summary>技术诊断</summary>
          <pre>{{ JSON.stringify(data.diagnostics, null, 2) }}</pre>
        </details>
        <p v-if="actionError" role="alert" class="form-error">
          {{ actionError }}
        </p>
        <div class="job-detail-actions">
          <Button
            v-if="['queued', 'running', 'paused'].includes(data.status)"
            variant="destructive"
            :disabled="pending"
            @click="action('cancel')"
            >{{ pending ? "处理中…" : "取消任务" }}</Button
          ><Button
            v-if="data.status === 'failed'"
            :disabled="pending"
            @click="action('retry')"
            >{{ pending ? "处理中…" : "重试失败任务" }}</Button
          ><Button variant="outline" @click="refresh">刷新详情</Button>
        </div></template
      >
    </section></AdminDialog
  >
</template>
<style scoped>
@layer components {
  .job-detail {
    padding: 24px;
    display: grid;
    gap: 20px;
  }
  .job-detail-heading {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .job-detail dl {
    display: grid;
    grid-template-columns: 90px minmax(0, 1fr);
    gap: 12px;
    font-size: 13px;
  }
  .job-detail dt {
    color: var(--muted-foreground);
  }
  .job-detail dd {
    overflow-wrap: anywhere;
  }
  .job-detail pre {
    background: var(--muted);
    padding: 16px;
    border-radius: 8px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 12px;
  }
  .job-detail-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
}
</style>
