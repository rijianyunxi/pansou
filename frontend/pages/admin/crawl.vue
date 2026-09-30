<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useCrawlQuery } from "@/composables/admin/useCrawlQuery";
import { useAdminConfirm } from "@/composables/admin/useAdminConfirm";
import { apiFetch, apiErrorMessage, setDocumentHead } from "@/src/appRuntime";
import type { CrawlChannel, CrawlOverview } from "@/types/crawl";
import { Tabs, TabsList, TabsTrigger } from "@/components/admin/ui/tabs";
import { Button } from "@/components/admin/ui/button";
import CrawlChannelsTab from "@/components/admin/crawl/CrawlChannelsTab.vue";
import CrawlJobsTab from "@/components/admin/crawl/CrawlJobsTab.vue";
import CrawlReviewTab from "@/components/admin/crawl/CrawlReviewTab.vue";
import CrawlChannelEditor from "@/components/admin/crawl/CrawlChannelEditor.vue";
import CrawlSettings from "@/components/admin/crawl/CrawlSettings.vue";
import CrawlMessagesSheet from "@/components/admin/crawl/CrawlMessagesSheet.vue";
import CrawlJobDialog from "@/components/admin/crawl/CrawlJobDialog.vue";
import CrawlJobDetail from "@/components/admin/crawl/CrawlJobDetail.vue";
setDocumentHead({ title: "TG 采集 - pansou" });
const route = useRoute(),
  router = useRouter();
const { confirm } = useAdminConfirm();
const tab = computed({
  get: () =>
    ["channels", "jobs", "review"].includes(String(route.query.tab))
      ? String(route.query.tab)
      : "channels",
  set: (v: string) => {
    void router.push({ query: { tab: v } });
  },
});
const settings = computed(() => route.query.settings === "1"),
  editId = computed(() =>
    typeof route.query.edit === "string" ? route.query.edit : undefined,
  ),
  messageChannel = computed(() =>
    typeof route.query.messages === "string" ? route.query.messages : undefined,
  ),
  messageId = computed(() => Number(route.query.message) || undefined),
  taskId = computed(() => Number(route.query.task) || undefined);
const channelsRef = ref<InstanceType<typeof CrawlChannelsTab>>(),
  jobsRef = ref<InstanceType<typeof CrawlJobsTab>>(),
  reviewRef = ref<InstanceType<typeof CrawlReviewTab>>();
const job = ref<{ channel: CrawlChannel; kind: string } | null>(null),
  notice = ref(""),
  error = ref("");
const {
  data: overview,
  error: overviewError,
  refresh: refreshOverview,
} = useCrawlQuery<CrawlOverview>(ref("/api/admin/crawl/overview"), ref({}));
function overlay(query: Record<string, string | number | undefined>) {
  const { edit, settings, messages, message, task, ...rest } = route.query;
  void router.push({ query: { ...rest, ...query } });
}
function close() {
  const { edit, settings, messages, message, task, ...rest } = route.query;
  void router.replace({ query: rest });
}
async function refresh() {
  await Promise.all([
    refreshOverview(),
    channelsRef.value?.refresh(),
    jobsRef.value?.refresh(),
    reviewRef.value?.refresh(),
  ]);
}
function saved() {
  notice.value = "频道配置已保存；未自动重解析历史。";
  close();
  void refresh();
}
function queued(id: number) {
  job.value = null;
  notice.value = "任务 #" + id + " 已排队，不代表已完成。";
  overlay({ task: id });
  void refresh();
}
async function archive(c: CrawlChannel) {
  if (
    !(await confirm(
      "归档 @" +
        c.id +
        "？将停止采集并取消公共发布，保留历史消息和资源。有用户绑定时会拒绝归档。",
    ))
  )
    return;
  error.value = "";
  try {
    await apiFetch(
      "/api/admin/crawl/channels/" + encodeURIComponent(c.id) + "/archive",
      { method: "POST" },
    );
    notice.value = "频道已归档，历史数据仍保留。";
    await refresh();
  } catch (e) {
    error.value = apiErrorMessage(e);
  }
}
watch(
  () => route.query.tab,
  () => {
    job.value = null;
  },
);
</script>
<template>
  <div class="admin-page crawl-workbench">
    <div class="crawl-overview">
      <div class="crawl-health">
        <span class="worker-indicator" :class="overview?.workerState" />Worker
        {{
          overview?.workerState === "online"
            ? "在线"
            : overview?.workerState === "offline"
              ? "未检测到在线进程"
              : "状态未知"
        }}<span>排队 {{ overview?.queued ?? "—" }}</span
        ><span>执行 {{ overview?.running ?? "—" }}</span
        ><span>失败 {{ overview?.failed ?? "—" }}</span
        ><span>待复核 {{ overview?.review ?? "—" }}</span>
      </div>
      <div class="crawl-overview-actions">
        <Button variant="outline" @click="refresh">刷新</Button
        ><Button variant="outline" @click="overlay({ settings: 1 })"
          >采集设置</Button
        ><Button @click="overlay({ edit: 'new' })">新增频道</Button>
      </div>
    </div>
    <p v-if="overview?.workerState === 'offline'" class="crawl-runtime-note">
      任务可排队，但不会立即执行。请运行 Rust
      worker；公开网页可访问历史不等于完整历史。
    </p>
    <p v-if="overviewError || error" role="alert" class="form-error">
      {{ error || overviewError }}
    </p>
    <p v-if="notice" role="status" class="feature-notice">{{ notice }}</p>
    <Tabs v-model="tab"
      ><TabsList aria-label="TG 采集工作区"
        ><TabsTrigger value="channels">频道</TabsTrigger
        ><TabsTrigger value="jobs"
          >任务
          <span v-if="overview"
            >({{ overview.queued + overview.running }})</span
          ></TabsTrigger
        ><TabsTrigger value="review"
          >待复核
          <span v-if="overview">({{ overview.review }})</span></TabsTrigger
        ></TabsList
      ></Tabs
    >
    <CrawlChannelsTab
      v-if="tab === 'channels'"
      ref="channelsRef"
      @edit="overlay({ edit: $event })"
      @messages="overlay({ messages: $event })"
      @task="overlay({ task: $event })"
      @job="(c, k) => (job = { channel: c, kind: k })"
      @archive="archive"
    /><CrawlJobsTab
      v-else-if="tab === 'jobs'"
      ref="jobsRef"
      @task="overlay({ task: $event })"
    /><CrawlReviewTab
      v-else
      ref="reviewRef"
      @message="(c, id) => overlay({ messages: c, message: id })"
    />
    <CrawlChannelEditor
      v-if="editId !== undefined"
      :key="editId"
      :id="editId === 'new' ? undefined : editId"
      @close="close"
      @saved="saved"
    /><CrawlSettings
      v-else-if="settings"
      @close="close"
      @saved="
        notice = '默认配置已保存';
        void refresh();
      "
    /><CrawlMessagesSheet
      v-else-if="messageChannel"
      :key="messageChannel"
      :channel="messageChannel"
      :initial-message="messageId"
      @close="close"
      @task="overlay({ task: $event })"
    /><CrawlJobDetail
      v-else-if="taskId"
      :id="taskId"
      @close="close"
      @changed="refresh"
    /><CrawlJobDialog
      v-else-if="job"
      :channel="job.channel"
      :kind="job.kind"
      @close="job = null"
      @queued="queued"
    />
  </div>
</template>
<style scoped>
@layer components {
  .crawl-workbench {
    display: grid;
    gap: 18px;
    min-width: 0;
  }
  .crawl-overview {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 16px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--background);
  }
  .crawl-health {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    font-size: 12px;
  }
  .crawl-health > span:not(.worker-indicator) {
    color: var(--muted-foreground);
  }
  .worker-indicator {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--muted-foreground);
  }
  .worker-indicator.online {
    background: #16a34a;
  }
  .worker-indicator.offline {
    background: #d97706;
  }
  .crawl-overview-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .crawl-runtime-note {
    font-size: 12px;
    line-height: 1.7;
    color: var(--muted-foreground);
  }
  @media (max-width: 640px) {
    .crawl-overview {
      padding: 12px;
    }
    .crawl-overview-actions {
      width: 100%;
    }
  }
}
</style>
