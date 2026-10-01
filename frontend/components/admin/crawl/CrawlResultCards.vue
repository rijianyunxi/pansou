<script setup lang="ts">
import type { ManagedResource } from "@/shared/apiModels";
defineProps<{ results: ManagedResource[] }>();
</script>
<template>
  <div class="crawl-result-cards">
    <p v-if="!results.length" class="tw:text-muted-foreground tw:text-sm">
      没有资源结果。
    </p>
    <article v-for="r in results" :key="r.id">
      <strong>{{ r.name }}</strong>
      <p>{{ r.description || "无描述" }}</p>
      <small
        >{{ r.datetime || "发布时间未知" }} ·
        {{ r.cloud_types.join(" / ") }}</small
      >
      <div v-for="link in r.links" :key="link.url" class="result-link">
        <span>{{ link.type }}</span
        ><a :href="link.url" target="_blank" rel="noopener noreferrer">{{
          link.url
        }}</a
        ><span v-if="link.password">提取码 {{ link.password }}</span>
      </div>
      <details>
        <summary>结构化 JSON</summary>
        <pre>{{ JSON.stringify(r, null, 2) }}</pre>
      </details>
    </article>
  </div>
</template>
<style scoped>
@layer components {
  .crawl-result-cards {
    display: grid;
    gap: 16px;
    min-width: 0;
  }
  .crawl-result-cards article {
    padding: 16px;
    border: 1px solid var(--border);
    border-radius: 8px;
    min-width: 0;
  }
  .crawl-result-cards p {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.7;
    font-size: 13px;
    margin: 10px 0;
    color: var(--muted-foreground);
  }
  .crawl-result-cards strong {
    overflow-wrap: anywhere;
  }
  .crawl-result-cards small {
    color: var(--muted-foreground);
  }
  .result-link {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: start;
    margin-top: 12px;
    font-size: 12px;
  }
  .result-link a {
    color: var(--primary);
    overflow-wrap: anywhere;
    min-width: 0;
    flex: 1;
  }
  .crawl-result-cards pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    background: var(--muted);
    border-radius: 6px;
    padding: 12px;
    font-size: 12px;
  }
  .crawl-result-cards details {
    margin-top: 12px;
    font-size: 12px;
  }
}
</style>
