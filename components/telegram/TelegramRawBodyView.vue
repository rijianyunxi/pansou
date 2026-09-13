<template>
  <div class="tg-raw-view">
    <div class="tg-raw-toolbar">
      <div class="tg-view-tabs" role="group" aria-label="原始正文查看方式">
        <button type="button" :aria-pressed="view === 'pretty'" @click="view = 'pretty'">格式化视图</button>
        <button type="button" :aria-pressed="view === 'source'" @click="view = 'source'">源码视图</button>
        <button
          type="button"
          :aria-pressed="view === 'render'"
          title="在 sandbox iframe 内渲染正文，不执行脚本"
          @click="view = 'render'"
        >页面渲染</button>
      </div>
      <TelegramCopyButton :text="body" label="复制正文" compact />
    </div>
    <p v-if="hasBody && sizeLabel" class="tg-raw-size" role="status">正文 {{ sizeLabel }}<template v-if="truncated"> · 已截断，不是完整报文</template></p>
    <template v-if="hasBody">
      <!-- 逐段转义后仅插入自有 <mark>，可安全用于 v-html -->
      <pre
        v-if="view !== 'render'"
        tabindex="0"
        class="tg-raw-pre"
        :aria-label="view === 'pretty' ? '格式化后的上游正文' : '上游正文源码'"
        v-html="highlighted"
      ></pre>
      <iframe
        v-else
        class="tg-raw-frame"
        sandbox=""
        :title="frameTitle"
        :srcdoc="srcdoc"
      ></iframe>
      <p class="tg-raw-legend">
        <span class="tg-legend-chip node">消息节点</span>
        <span class="tg-legend-chip keyword">关键词</span>
        <span class="tg-legend-chip link">网盘 / 磁力链接</span>
        <small v-if="stats.nodes">消息节点 {{ stats.nodes }} 处</small>
        <small v-if="stats.keywords">关键词命中 {{ stats.keywords }} 处</small>
        <small v-if="stats.links">链接 {{ stats.links }} 处</small>
      </p>
    </template>
    <p v-else class="tg-raw-empty">{{ emptyText || "未取得响应正文。" }}</p>
  </div>
</template>
<script setup lang="ts">
import TelegramCopyButton from "./TelegramCopyButton.vue";
import { formatHtmlPretty, renderHighlightedHtml } from "../../utils/telegramProbeView";

const props = withDefaults(
  defineProps<{
    body: string;
    keyword?: string;
    bodyLength?: number | null;
    truncated?: boolean;
    baseUrl?: string;
    frameTitle?: string;
    emptyText?: string;
  }>(),
  { keyword: "", bodyLength: null, truncated: false, baseUrl: "", frameTitle: "上游响应渲染", emptyText: "" },
);

const view = ref<"pretty" | "source" | "render">("pretty");
const hasBody = computed(() => !!props.body);
const sizeLabel = computed(() => {
  const size = props.bodyLength ?? props.body.length;
  return size ? `${size.toLocaleString("en-US")} 字符` : "";
});
const highlighted = computed(() => {
  if (!props.body) return "";
  const text = view.value === "pretty" ? formatHtmlPretty(props.body) : props.body;
  return renderHighlightedHtml(text, { keyword: props.keyword }).html;
});
const stats = computed(() => {
  if (!props.body || view.value === "render") return { links: 0, nodes: 0, keywords: 0 };
  const text = view.value === "pretty" ? formatHtmlPretty(props.body) : props.body;
  return renderHighlightedHtml(text, { keyword: props.keyword }).stats;
});

const srcdoc = computed(() => {
  if (!props.body) return "";
  const baseTag = props.baseUrl
    ? `<base href="${props.baseUrl.replace(/"/g, "%22")}">`
    : "";
  if (!baseTag) return props.body;
  if (/<head[^>]*>/i.test(props.body)) return props.body.replace(/<head[^>]*>/i, (match) => `${match}${baseTag}`);
  if (/<html[^>]*>/i.test(props.body)) return props.body.replace(/<html[^>]*>/i, (match) => `${match}${baseTag}`);
  if (/<!doctype[^>]*>/i.test(props.body)) return props.body.replace(/<!doctype[^>]*>/i, (match) => `${match}${baseTag}`);
  return `${baseTag}${props.body}`;
});
</script>
<style scoped>
.tg-raw-view {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.tg-raw-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.tg-view-tabs {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.tg-view-tabs button {
  min-height: 0;
  padding: 5px 10px;
  font-size: 11px;
  line-height: 1.4;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  background: #fff;
  color: #475569;
  cursor: pointer;
}
.tg-view-tabs button[aria-pressed="true"] {
  border-color: #2563eb;
  color: #1d4ed8;
  background: #eff6ff;
  font-weight: 700;
}
.tg-raw-size {
  margin: 0;
  font-size: 10px;
  color: #a16207;
}
.tg-raw-pre {
  margin: 0;
  padding: 10px;
  max-height: 420px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  color: #475569;
  font: 10px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.tg-raw-frame {
  display: block;
  width: 100%;
  height: 55vh;
  min-height: 300px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
}
.tg-raw-legend {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 0;
  font-size: 10px;
  color: #64748b;
}
.tg-legend-chip {
  display: inline-flex;
  align-items: center;
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 10px;
}
.tg-legend-chip.node {
  background: #e0e7ff;
  color: #3730a3;
}
.tg-legend-chip.keyword {
  background: #fde68a;
  color: #92400e;
}
.tg-legend-chip.link {
  background: #bbf7d0;
  color: #166534;
}
.tg-legend-chip::before {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 2px;
  margin-right: 5px;
}
.tg-legend-chip.node::before {
  background: #6366f1;
}
.tg-legend-chip.keyword::before {
  background: #f59e0b;
}
.tg-legend-chip.link::before {
  background: #22c55e;
}
mark.tg-hit-node {
  background: #e0e7ff;
  color: inherit;
  border-bottom: 1px solid #6366f1;
}
mark.tg-hit-keyword {
  background: #fde68a;
  color: inherit;
  border-bottom: 1px solid #f59e0b;
}
mark.tg-hit-link {
  background: #bbf7d0;
  color: inherit;
  border-bottom: 1px solid #22c55e;
}
.tg-raw-empty {
  margin: 0;
  border: 1px dashed #cbd5e1;
  border-radius: 8px;
  padding: 22px 14px;
  text-align: center;
  color: #94a3b8;
  font-size: 11px;
}
@media (max-width: 640px) {
  .tg-raw-toolbar {
    align-items: stretch;
    flex-direction: column;
  }
  .tg-view-tabs button {
    flex: 1;
    padding: 8px 6px;
    white-space: nowrap;
  }
  .tg-raw-pre {
    font-size: 9px;
    max-height: 320px;
  }
  .tg-raw-frame {
    height: 45vh;
    min-height: 240px;
  }
}
</style>
