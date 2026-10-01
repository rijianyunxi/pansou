<script setup lang="ts">
import { computed, ref } from "vue";
import { useCrawlQuery } from "@/composables/admin/useCrawlQuery";
import { crawlTime, crawlStatus, type CrawlMessage } from "@/types/crawl";
import { Button } from "../ui/button";
import CrawlResultCards from "./CrawlResultCards.vue";
const props = defineProps<{ channel: string; id: number }>();
const emit = defineEmits<{ back: [] }>();
const url = computed(
  () => "/api/admin/crawl/channels/" + encodeURIComponent(props.channel) + "/messages/" + props.id,
);
const { data, loading, error, refresh } = useCrawlQuery<CrawlMessage>(url, ref({}), 0);
</script>
<template>
  <section class="message-detail">
    <div class="message-detail-toolbar">
      <Button type="button" variant="outline" size="sm" @click="emit('back')">返回消息列表</Button>
      <Button type="button" variant="outline" size="sm" :disabled="loading" @click="refresh">刷新已存结果</Button>
    </div>
    <p v-if="loading" role="status">正在加载消息详情…</p>
    <p v-if="error" role="alert" class="form-error">{{ error }}</p>
    <template v-if="data">
      <div class="message-meta">
        <strong>@{{ channel }} / #{{ id }}</strong>
        <span>{{ crawlStatus(data.status) }} · {{ crawlTime(data.publishedAt) }}</span>
        <small>已存解析版本：{{ data.parseVersion }}</small>
      </div>
      <p v-if="data.parseError" role="alert" class="form-error">{{ data.parseError }}</p>
      <section aria-label="已存资源">
        <h3>已存资源</h3>
        <p class="message-help">这是消息来源关系的已存结果。人工覆盖 / 停用会影响最终可搜索资源。</p>
        <CrawlResultCards v-if="data.stored?.length" :results="data.stored.map((s) => s.result)" />
        <p v-else class="message-help" role="status">这条消息没有已存资源。</p>
        <p v-for="s in data.stored?.filter((s) => s.manualOverride || !s.enabled || s.deleted)"
          :key="s.result.id" class="message-help">
          {{ s.result.name }}：{{ s.manualOverride ? "人工覆盖 " : "" }}{{ !s.enabled ? "停用 " : "" }}{{ s.deleted ? "已删除" : "" }}
        </p>
      </section>
    </template>
  </section>
</template>
<style scoped>
@layer components {
  .message-detail {
    display: grid;
    gap: 18px;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .message-detail-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .message-meta {
    display: grid;
    gap: 6px;
    font-size: 13px;
  }
  .message-detail h3 {
    font-size: 14px;
    margin-bottom: 8px;
  }
  .message-meta small,
  .message-help {
    font-size: 12px;
    line-height: 1.7;
    color: var(--muted-foreground);
  }
  .message-help {
    margin-bottom: 12px;
  }
}
</style>
