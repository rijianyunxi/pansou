<script setup lang="ts">
import { computed } from "vue";
import { useCrawlQuery } from "@/composables/admin/useCrawlQuery";
import { crawlTime, type CrawlMessageDetail } from "@/types/crawl";
import { Button } from "../ui/button";

const props = defineProps<{ channel: string; messageId: number }>();
const url = computed(() => `/api/admin/crawl/channels/${encodeURIComponent(props.channel)}/messages/${props.messageId}`);
const params = computed(() => ({}));
const { data, loading, error, refresh } = useCrawlQuery<CrawlMessageDetail>(url, params, 0);
</script>

<template>
  <section class="failure-detail" aria-label="失败消息详情" :aria-busy="loading">
    <p v-if="loading" role="status">正在加载原始消息…</p>
    <div v-else-if="error" role="alert"><p>{{ error }}</p><Button variant="outline" size="sm" @click="refresh">重新加载</Button></div>
    <template v-else-if="data">
      <dl class="failure-metadata">
        <div><dt>错误信息</dt><dd>{{ data.errorMessage || '无错误信息' }}</dd></div>
        <div><dt>处理时间</dt><dd>{{ crawlTime(data.taskAt) }}</dd></div>
        <div><dt>发布时间</dt><dd>{{ crawlTime(data.publishedAt) }}</dd></div>
      </dl>
      <a :href="data.messageUrl" target="_blank" rel="noopener noreferrer" class="failure-source">查看 Telegram 原帖 ↗</a>
      <template v-if="data.rawHtml !== null">
        <p class="failure-content-label">原始消息正文</p>
        <pre class="failure-content">{{ data.rawText || '该消息没有文字正文，请查看原始 HTML 或原帖。' }}</pre>
        <details class="failure-html"><summary>查看原始 HTML</summary><pre class="failure-content">{{ data.rawHtml }}</pre></details>
      </template>
      <p v-else class="failure-missing">该记录未保存原始内容。旧记录需要重试采集后才能补齐原文。</p>
    </template>
  </section>
</template>

<style scoped>
@layer components {
.failure-detail{margin-top:12px;padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--muted);font-size:12px;line-height:1.7}
.failure-detail p{margin:0}.failure-metadata{display:grid;gap:6px;margin:0 0 10px}.failure-metadata div{display:grid;grid-template-columns:64px minmax(0,1fr);gap:10px}.failure-metadata dt{color:var(--muted-foreground)}.failure-metadata dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.failure-source{color:var(--primary);text-decoration:underline;text-underline-offset:3px}.failure-detail .failure-content-label{margin-top:12px;font-weight:500}
.failure-content{max-height:360px;overflow:auto;margin:6px 0 0;padding:12px;border:1px solid var(--border);border-radius:6px;background:var(--background);color:var(--foreground);font-family:inherit;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}
.failure-html{margin-top:12px}.failure-html summary{cursor:pointer}.failure-html .failure-content{font-family:ui-monospace,monospace}.failure-detail .failure-missing{margin-top:12px;color:var(--muted-foreground)}
}
</style>
