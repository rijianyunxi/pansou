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
        <section class="debug-request-card" aria-label="调试请求">
          <div class="debug-section-heading">
            <div>
              <span class="eyebrow">REQUEST</span>
              <strong>发起一次探测</strong>
            </div>
            <span class="debug-limit">超时 12 秒 · 不自动重试</span>
          </div>
          <label class="field-label" for="drawer-debug-keyword">测试关键词</label>
          <div class="debug-controls">
            <input id="drawer-debug-keyword" :value="keyword" :disabled="running" maxlength="100" placeholder="输入测试关键词" @input="$emit('update:keyword', ($event.target as HTMLInputElement).value)" @keydown.enter="!running && $emit('send')" />
            <button class="button primary" type="button" :disabled="running || !keyword.trim()" @click="$emit('send')">
              <span v-if="running" class="spinner"></span><ConsoleIcon v-else name="play" :size="15" />{{ running ? '请求中…' : '发送请求' }}
            </button>
          </div>
          <div class="request-line"><span class="method-tag" :class="source.method.toLowerCase()">{{ source.method }}</span><code :title="requestUrl">{{ requestUrl }}</code></div>
        </section>

        <section class="debug-response-section" aria-label="调试响应">
          <div class="debug-section-heading response-heading">
            <div>
              <span class="eyebrow">RESPONSE</span>
              <strong>响应检查</strong>
            </div>
            <div v-if="report" class="response-meta">
              <span v-if="report.httpStatus" class="response-chip" :class="statusClass">HTTP {{ report.httpStatus }}</span>
              <span v-if="responseContentType" class="response-chip">{{ responseContentType }}</span>
              <span v-if="report.elapsedMs" class="response-chip">{{ report.elapsedMs }} ms</span>
            </div>
          </div>

          <div class="response-tabs" role="tablist" aria-label="调试响应视图">
            <button type="button" :class="{ active: responseTab === 'unified' }" @click="$emit('update:responseTab', 'unified')">统一结果 <span>{{ report?.results.length || 0 }}</span></button>
            <button type="button" :class="{ active: responseTab === 'raw' }" @click="$emit('update:responseTab', 'raw')">原始响应</button>
            <button type="button" :class="{ active: responseTab === 'request' }" @click="$emit('update:responseTab', 'request')">请求参数</button>
            <button class="icon-button" type="button" aria-label="复制当前调试内容" @click="$emit('copy')"><ConsoleIcon name="copy" :size="14" /></button>
          </div>

          <div v-if="responseTab === 'raw' && isHtmlResponse" class="raw-view-toolbar" role="group" aria-label="HTML 响应视图">
            <span class="raw-view-label"><ConsoleIcon name="code" :size="14" />检测到 HTML 响应</span>
            <div class="raw-view-switcher">
              <button type="button" :class="{ active: rawView === 'preview' }" @click="rawView = 'preview'">安全预览</button>
              <button type="button" :class="{ active: rawView === 'source' }" @click="rawView = 'source'">源代码</button>
            </div>
          </div>

          <div class="code-window drawer-code-window" :class="{ 'html-preview-window': responseTab === 'raw' && isHtmlResponse && rawView === 'preview' }">
            <div class="code-window-header"><span><i></i><i></i><i></i></span><span>{{ fileName }}</span><small>{{ report?.httpStatus ? `HTTP ${report.httpStatus}` : 'READY' }}</small></div>
            <iframe
              v-if="responseTab === 'raw' && isHtmlResponse && rawView === 'preview' && report"
              class="html-response-preview"
              title="上游 HTML 响应安全预览"
              :srcdoc="safeHtmlPreview"
              sandbox=""
              referrerpolicy="no-referrer"
            ></iframe>
            <pre v-else-if="report || responseTab === 'request'" tabindex="0">{{ debugText }}</pre>
            <div v-else class="code-empty"><ConsoleIcon name="code" :size="30" /><strong>等待第一个响应</strong><p>点击「发送请求」，在这里检查上游数据。</p><code>// no request sent yet</code></div>
          </div>
          <p v-if="responseTab === 'raw' && isHtmlResponse && rawView === 'preview'" class="field-hint preview-safety-note"><ConsoleIcon name="shield" :size="14" />预览运行在无脚本 sandbox 中，脚本、事件处理器、表单和外部框架均已禁用。</p>
          <p v-if="report?.rawTruncated && responseTab === 'raw'" class="field-hint">原始响应预览已截断；统一结果使用完整响应解析。</p>
          <div v-if="report" class="request-outcome" :class="report.state"><ConsoleIcon name="info" :size="16" /><span>{{ report.message }}</span></div>
        </section>

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
import { computed, ref } from "vue";
import ConsoleIcon from "./ConsoleIcon.vue";
import type { UpstreamDefinition, UpstreamProbe } from "../../config/upstreams";

const props = defineProps<{
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

const rawView = ref<"preview" | "source">("preview");
const rawText = computed(() => props.report?.raw || "");
const responseContentType = computed(() => {
  const trace = [...(props.report?.traces || [])].reverse().find((item) => item.contentType);
  return trace?.contentType?.split(";")[0]?.trim() || "";
});
const isHtmlResponse = computed(() => {
  const raw = rawText.value.trimStart();
  return /(?:text\/html|application\/xhtml\+xml)/i.test(responseContentType.value) || /<!doctype\s+html|<html(?:\s|>)|<(?:head|body|main|div|table)(?:\s|>)/i.test(raw);
});
const statusClass = computed(() => {
  const status = props.report?.httpStatus || 0;
  return status >= 200 && status < 300 ? "success" : status >= 400 ? "error" : "warning";
});
const fileName = computed(() => {
  if (props.responseTab === "request") return "request.json";
  if (props.responseTab === "raw") return isHtmlResponse.value && rawView.value === "preview" ? "response.preview.html" : "response.raw";
  return "SearchResult.json";
});
const safeHtmlPreview = computed(() => sanitizeHtmlForPreview(rawText.value));

/**
 * The iframe sandbox is the final safety boundary. Sanitising here as well
 * prevents event handlers, javascript URLs, nested browsing contexts and
 * active embeds from being copied into the preview document.
 */
function sanitizeHtmlForPreview(html: string): string {
  if (!html) return "<p style=\"font:14px system-ui;color:#8b8f98\">暂无 HTML 响应</p>";
  if (typeof DOMParser === "undefined") return sanitizeHtmlFallback(html);

  const document = new DOMParser().parseFromString(html, "text/html");
  document.querySelectorAll("script, noscript, iframe, frame, frameset, object, embed, applet, base, meta[http-equiv]").forEach((node) => node.remove());
  document.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
      else if (["href", "src", "action", "formaction", "xlink:href"].includes(attribute.name.toLowerCase()) && /^\s*(?:javascript:|data:)/i.test(attribute.value)) element.removeAttribute(attribute.name);
    }
  });
  const style = document.createElement("style");
  style.textContent = "html{background:#fff;color:#20242b}body{margin:20px;font:14px/1.6 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}pre{white-space:pre-wrap;word-break:break-word}a{color:#315edb}table{max-width:100%;border-collapse:collapse}td,th{border:1px solid #dfe3ea;padding:6px 8px}";
  document.head.prepend(style);
  return `<!doctype html>${document.documentElement.outerHTML}`;
}

function sanitizeHtmlFallback(html: string): string {
  return html
    .replace(/<\s*(script|noscript|iframe|frame|frameset|object|embed|applet|base|meta)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|noscript|iframe|frame|frameset|object|embed|applet|base|meta)\b[^>]*\/?\s*>/gi, "")
    .replace(/\s+on[a-z-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+(?:href|src|action|formaction)\s*=\s*(?:"\s*(?:javascript:|data:)[^"]*"|'\s*(?:javascript:|data:)[^']*'|[^\s>]+)/gi, "");
}

function displayUrl(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}
</script>

<style scoped>
.debug-request-card,
.debug-response-section {
  border: 1px solid var(--line, #e4e6eb);
  border-radius: 16px;
  padding: 16px;
  background: color-mix(in srgb, var(--panel, #fff) 94%, #f4f6fb);
}
.debug-response-section { margin-top: 16px; }
.debug-section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.debug-section-heading > div:first-child { display: grid; gap: 3px; }
.debug-section-heading strong { font-size: 15px; }
.debug-limit, .response-chip { color: #8a8f99; font-size: 11px; white-space: nowrap; }
.response-meta { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.response-chip { border: 1px solid #e1e4ea; border-radius: 999px; padding: 4px 8px; background: #fff; }
.response-chip.success { color: #168a5b; border-color: #b9e5d0; background: #f1fbf6; }
.response-chip.error { color: #c84b43; border-color: #f1c4c0; background: #fff5f4; }
.response-chip.warning { color: #a16b14; border-color: #ecd9aa; background: #fffaf0; }
.request-line code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.raw-view-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 11px; border: 1px solid #e3e6ec; border-bottom: 0; border-radius: 10px 10px 0 0; background: #fafbfc; }
.raw-view-label { display: inline-flex; align-items: center; gap: 6px; color: #4e5969; font-size: 12px; }
.raw-view-switcher { display: inline-flex; padding: 2px; border-radius: 8px; background: #eceff4; }
.raw-view-switcher button { border: 0; border-radius: 6px; padding: 5px 9px; color: #737b88; background: transparent; font: inherit; font-size: 12px; cursor: pointer; }
.raw-view-switcher button.active { color: #28334a; background: #fff; box-shadow: 0 1px 3px #1d29391a; }
.html-preview-window { border-radius: 0 0 10px 10px; }
.html-response-preview { display: block; width: 100%; min-height: 330px; border: 0; background: #fff; }
.preview-safety-note { display: flex; align-items: center; gap: 5px; color: #6f7784; }
@media (max-width: 560px) {
  .debug-section-heading { display: block; }
  .debug-limit, .response-meta { display: flex; margin-top: 8px; justify-content: flex-start; }
  .raw-view-toolbar { align-items: flex-start; flex-direction: column; }
}
</style>
