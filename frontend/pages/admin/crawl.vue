<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useCrawlQuery } from "@/composables/admin/useCrawlQuery";
import { setDocumentHead } from "@/src/appRuntime";
import type { CrawlOverview } from "@/types/crawl";
import { Button } from "@/components/admin/ui/button";
import CrawlChannelsTab from "@/components/admin/crawl/CrawlChannelsTab.vue";
import CrawlChannelEditor from "@/components/admin/crawl/CrawlChannelEditor.vue";
import CrawlSettings from "@/components/admin/crawl/CrawlSettings.vue";
import CrawlMessagesSheet from "@/components/admin/crawl/CrawlMessagesSheet.vue";
import CrawlJobDetail from "@/components/admin/crawl/CrawlJobDetail.vue";
setDocumentHead({ title: "TG 采集 - pansou" });
const route = useRoute(),
  router = useRouter();
const settings = computed(() => route.query.settings === "1"),
  editId = computed(() =>
    typeof route.query.edit === "string" ? route.query.edit : undefined,
  ),
  messageChannel = computed(() =>
    typeof route.query.messages === "string" ? route.query.messages : undefined,
  ),
  messageId = computed(() => Number(route.query.message) || undefined),
  taskId = computed(() => Number(route.query.task) || undefined);
const channelsRef = ref<InstanceType<typeof CrawlChannelsTab>>();
const notice = ref("");
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
  ]);
}
function saved() {
  notice.value = "频道配置已保存，首次采集自动启动，历史断点会保留。";
  close();
  void refresh();
}
</script>
<template>
  <div class="admin-page crawl-workbench">
    <div class="crawl-overview">
      <div class="crawl-health">
        <span class="worker-indicator" :class="overview?.workerState" />Worker
        {{
          overview?.workerState === "online"
            ? overview.workerEnabled === false ? "在线 · 调度已暂停" : "在线"
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
      未检测到采集 Worker，任务会保留在队列。请到
      <RouterLink to="/admin/monitor">运行监控</RouterLink>
      检查后台任务开关与服务状态；公开网页可访问历史不等于完整历史。
    </p>
    <p v-else-if="overview?.workerEnabled === false" class="crawl-runtime-note">
      TG 后台调度已暂停，任务会保留在队列。可到
      <RouterLink to="/admin/monitor">运行监控</RouterLink>恢复调度。
    </p>
    <p v-if="overviewError" role="alert" class="form-error">
      {{ overviewError }}
    </p>
    <p v-if="notice" role="status" class="feature-notice">{{ notice }}</p>
    <CrawlChannelsTab ref="channelsRef" @edit="overlay({edit:$event})" @messages="overlay({messages:$event})" @task="overlay({task:$event})" @changed="refreshOverview" />
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
