<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useCrawlQuery } from "@/composables/admin/useCrawlQuery";
import {
  crawlTime,
  crawlStatus,
  crawlReason,
  type CrawlChannel,
  type ChannelPage,
} from "@/types/crawl";
import { policyLabel } from "@/types/outbound";
import AdminSelect from "../AdminSelect.vue";
import AdminRowActions from "../AdminRowActions.vue";
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
const emit = defineEmits<{
  edit: [id: string];
  messages: [id: string];
  job: [channel: CrawlChannel, kind: string];
  task: [id: number];
  archive: [channel: CrawlChannel];
}>();
const route = useRoute(),
  router = useRouter();
const q = ref(String(route.query.q || "")),
  enabled = ref(String(route.query.enabled || "")),
  published = ref(String(route.query.published || "")),
  managed = ref(""),
  page = ref(Number(route.query.page) || 1);
const params = computed(() => ({
  q: q.value,
  enabled: enabled.value,
  published: published.value,
  managed: managed.value,
  page: page.value,
  pageSize: 20,
}));
const { data, loading, error, updatedAt, refresh } = useCrawlQuery<ChannelPage>(
  ref("/api/admin/crawl/channels"),
  params,
);
watch([enabled, published, managed], () => (page.value = 1));
function search() {
  page.value = 1;
  void refresh();
}
watch(
  params,
  () =>
    void router.replace({
      query: {
        ...route.query,
        q: q.value || undefined,
        enabled: enabled.value || undefined,
        published: published.value || undefined,
        page: page.value > 1 ? page.value : undefined,
      },
    }),
);
defineExpose({ refresh });
</script>
<template>
  <div class="crawl-tab">
    <div class="query-toolbar">
      <Input
        v-model="q"
        placeholder="搜索频道名称 / username"
        aria-label="搜索频道"
        @keydown.enter="search"
      /><AdminSelect v-model="enabled" aria-label="采集状态"
        ><option value="">全部采集状态</option>
        <option value="true">允许采集</option>
        <option value="false">已暂停</option></AdminSelect
      ><AdminSelect v-model="published" aria-label="公共搜索状态"
        ><option value="">全部搜索状态</option>
        <option value="true">已公共发布</option>
        <option value="false">未公共发布</option></AdminSelect
      ><AdminSelect v-model="managed" aria-label="频道来源"
        ><option value="">全部频道</option>
        <option value="true">管理员维护</option>
        <option value="false">用户请求</option></AdminSelect
      ><Button variant="outline" @click="search">查询</Button>
    </div>
    <p v-if="error" role="alert" class="form-error">
      {{ error }} <Button variant="outline" @click="refresh">重试</Button>
    </p>
    <p v-if="loading" role="status" class="admin-loading">正在加载频道…</p>
    <Card class="table-panel"
      ><Table class="crawl-channels-table"
        ><TableHeader
          ><TableRow
            ><TableHead>频道</TableHead><TableHead>采集 / 搜索</TableHead
            ><TableHead>数据</TableHead><TableHead>同步</TableHead
            ><TableHead>当前 / 最近任务</TableHead
            ><TableHead>操作</TableHead></TableRow
          ></TableHeader
        ><TableBody
          ><TableRow v-for="c in data?.items" :key="c.id"
            ><TableCell
              ><strong>{{ c.name || c.id }}</strong>
              <p>@{{ c.id }} · {{ c.managed ? "管理员维护" : "用户请求" }}</p>
              <p>{{ policyLabel(c.outbound) }}</p>
              <p v-if="!c.effectiveOutbound" class="crawl-warning">
                待配置默认出站策略
              </p></TableCell
            ><TableCell
              ><p>{{ c.enabled ? "允许采集" : "已暂停" }}</p>
              <p>{{ c.published ? "已公共发布" : "未公共发布" }}</p></TableCell
            ><TableCell
              ><Button variant="ghost" size="sm" @click="emit('messages', c.id)"
                >{{ c.messageCount }} 条消息</Button
              >
              <p>
                {{ c.resourceCount }} 有效资源 · {{ c.failureCount }} 待复核
              </p></TableCell
            ><TableCell
              ><p>最近：{{ crawlTime(c.lastSyncedAt) }}</p>
              <p>下次：{{ c.enabled ? crawlTime(c.nextSyncAt) : "暂停" }}</p>
              <p>{{ crawlReason(c.coverage) }}</p></TableCell
            ><TableCell
              ><Button
                v-if="c.latestJob"
                variant="ghost"
                size="sm"
                @click="emit('task', c.latestJob.id)"
                >#{{ c.latestJob.id }} ·
                {{ crawlStatus(c.latestJob.status) }}</Button
              ><span v-else>暂无任务</span>
              <p
                v-if="c.lastError"
                class="crawl-error-summary"
                :title="c.lastError"
              >
                {{ c.lastError }}
              </p></TableCell
            ><TableCell
              ><AdminRowActions
                ><Button variant="outline" @click="emit('edit', c.id)"
                  >编辑频道</Button
                ><Button variant="outline" @click="emit('messages', c.id)"
                  >查看消息</Button
                ><Button
                  variant="outline"
                  :disabled="!c.enabled"
                  @click="emit('job', c, 'sync')"
                  >立即同步</Button
                ><Button
                  variant="outline"
                  :disabled="!c.enabled"
                  @click="emit('job', c, 'backfill')"
                  >回填 / 继续历史</Button
                ><Button
                  variant="outline"
                  :disabled="!c.enabled"
                  @click="emit('job', c, 'review')"
                  >近期编辑复查</Button
                ><Button
                  variant="outline"
                  :disabled="!c.enabled"
                  @click="emit('job', c, 'reparse')"
                  >重解析原文</Button
                ><Button variant="destructive" @click="emit('archive', c)"
                  >归档频道</Button
                ></AdminRowActions
              ></TableCell
            ></TableRow
          ><TableRow v-if="!loading && !data?.items.length"
            ><TableCell colspan="6"
              >没有匹配的频道。可直接在此页面新增公开 TG 频道。</TableCell
            ></TableRow
          ></TableBody
        ></Table
      >
      <footer class="table-footer">
        <span
          >共 {{ data?.total || 0 }} 个频道 · 更新 {{ updatedAt || "—" }}</span
        >
        <div class="crawl-pagination">
          <Button
            variant="outline"
            size="sm"
            :disabled="page <= 1 || loading"
            @click="page--"
            >上一页</Button
          ><span
            >{{ page }} /
            {{ Math.max(1, Math.ceil((data?.total || 0) / 20)) }}</span
          ><Button
            variant="outline"
            size="sm"
            :disabled="page * 20 >= (data?.total || 0) || loading"
            @click="page++"
            >下一页</Button
          >
        </div>
      </footer></Card
    >
  </div>
</template>
<style scoped>
@layer components {
  .crawl-tab {
    display: grid;
    gap: 16px;
  }
  .crawl-tab .query-toolbar input {
    max-width: 280px;
  }
  .crawl-tab .query-toolbar .admin-select-trigger {
    max-width: 180px;
  }
  .crawl-channels-table {
    min-width: 1060px;
  }
  .crawl-channels-table p {
    font-size: 12px;
    color: var(--muted-foreground);
    line-height: 1.6;
    margin-top: 5px;
  }
  .crawl-channels-table strong {
    display: block;
    max-width: 220px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .crawl-channels-table .crawl-warning {
    color: var(--destructive);
  }
  .crawl-error-summary {
    max-width: 180px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .crawl-pagination {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
}
</style>
