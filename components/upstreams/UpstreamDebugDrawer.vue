<template>
  <div class="drawer-backdrop" @click.self="$emit('close')">
    <aside class="side-drawer debug-drawer" role="dialog" aria-modal="true" aria-labelledby="upstream-debug-title">
      <header class="drawer-header">
        <div class="drawer-title-group">
          <span class="source-avatar large" :style="{ '--source-color': source.color }">{{ source.initials }}</span>
          <div>
            <span class="eyebrow">LIVE REQUEST</span>
            <h2 id="upstream-debug-title">调试 {{ source.name }}</h2>
            <p>发起一次真实请求，检查原始响应与统一结果。</p>
          </div>
        </div>
        <button class="icon-button" type="button" aria-label="关闭调试抽屉" @click="$emit('close')"><ConsoleIcon name="close" /></button>
      </header>

      <div class="drawer-body debug-drawer-body">
        <label class="field-label" for="drawer-debug-keyword">测试关键词</label>
        <div class="debug-controls">
          <input id="drawer-debug-keyword" :value="keyword" :disabled="running" maxlength="100" placeholder="输入测试关键词" @input="$emit('update:keyword', ($event.target as HTMLInputElement).value)" @keydown.enter="!running && $emit('send')" />
          <button class="button primary" type="button" :disabled="running || !keyword.trim()" @click="$emit('send')">
            <span v-if="running" class="spinner"></span><ConsoleIcon v-else name="play" :size="15" />{{ running ? '请求中…' : '发送请求' }}
          </button>
        </div>
        <p class="field-hint">单次探测 · 跳过缓存 · 不自动重试 · 最长 12 秒</p>
        <div class="request-line"><span class="method-tag" :class="source.method.toLowerCase()">{{ source.method }}</span><code>{{ requestUrl }}</code></div>

        <div class="response-tabs" role="tablist" aria-label="调试响应视图">
          <button type="button" :class="{ active: responseTab === 'unified' }" @click="$emit('update:responseTab', 'unified')">统一结果 <span>{{ report?.results.length || 0 }}</span></button>
          <button type="button" :class="{ active: responseTab === 'raw' }" @click="$emit('update:responseTab', 'raw')">原始响应</button>
          <button type="button" :class="{ active: responseTab === 'request' }" @click="$emit('update:responseTab', 'request')">请求参数</button>
          <button class="icon-button" type="button" aria-label="复制当前调试内容" @click="$emit('copy')"><ConsoleIcon name="copy" :size="14" /></button>
        </div>
        <div class="code-window drawer-code-window">
          <div class="code-window-header"><span><i></i><i></i><i></i></span><span>{{ responseTab === 'request' ? 'request.json' : responseTab === 'raw' ? 'response.raw' : 'SearchResult.json' }}</span><small>{{ report?.httpStatus ? `HTTP ${report.httpStatus}` : 'READY' }}</small></div>
          <pre v-if="report || responseTab === 'request'" tabindex="0">{{ debugText }}</pre>
          <div v-else class="code-empty"><ConsoleIcon name="code" :size="30" /><strong>等待第一个响应</strong><p>点击「发送请求」，在这里检查上游数据。</p><code>// no request sent yet</code></div>
        </div>
        <p v-if="report?.rawTruncated && responseTab === 'raw'" class="field-hint">原始响应预览已截断；统一结果使用完整响应解析。</p>
        <div v-if="report" class="request-outcome" :class="report.state"><ConsoleIcon name="info" :size="16" /><span>{{ report.message }}</span></div>

        <div class="trace-section">
          <div class="section-label">请求轨迹 <span class="tiny-muted">{{ report?.traces.length || 0 }} REQUESTS</span></div>
          <div v-for="(trace, index) in report?.traces || []" :key="index" class="trace-row">
            <span class="trace-index">{{ String(index + 1).padStart(2, '0') }}</span>
            <div><strong>{{ trace.method }} <span>{{ displayUrl(trace.url) }}</span></strong><p>{{ trace.error || `${trace.contentType || 'unknown'} · ${(trace.bytes / 1024).toFixed(1)} KB` }}</p></div>
            <span class="trace-status" :class="{ failed: !trace.status || trace.status >= 300 }">{{ trace.status || 'ERR' }}<small>{{ trace.elapsedMs }} ms</small></span>
          </div>
          <p v-if="!report" class="field-hint">请求完成后显示每一步的 HTTP 状态与耗时。</p>
        </div>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
import ConsoleIcon from "./ConsoleIcon.vue";
import type { UpstreamDefinition, UpstreamProbe } from "../../config/upstreams";

defineProps<{
  source: UpstreamDefinition;
  report?: UpstreamProbe;
  keyword: string;
  running: boolean;
  responseTab: "unified" | "raw" | "request";
  requestUrl: string;
  debugText: string;
}>();

defineEmits<{
  close: [];
  send: [];
  copy: [];
  "update:keyword": [value: string];
  "update:responseTab": [value: "unified" | "raw" | "request"];
}>();

function displayUrl(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}
</script>
