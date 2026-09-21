<template>
  <div class="source-debug-panel" :class="{ embedded }">
    <section class="debug-request-card" aria-label="测试请求">
      <div v-if="showRequestDetails" class="debug-section-heading">
        <div>
          <span class="eyebrow">REQUEST</span>
          <strong>发起测试请求</strong>
        </div>
        <span class="debug-limit">使用系统统一超时 · 不自动重试</span>
      </div>
      <label class="field-label" :for="keywordInputId">测试关键词</label>
      <div class="debug-controls">
        <input
          :id="keywordInputId"
          :value="keyword"
          :disabled="running"
          maxlength="100"
          placeholder="输入测试关键词"
          @input="$emit('update:keyword', ($event.target as HTMLInputElement).value)"
          @keydown.enter.prevent="canSend && $emit('send')"
        />
        <button class="button primary" type="button" :disabled="!canSend" @click="$emit('send')">
          <span v-if="running" class="spinner"></span>
          <ConsoleIcon v-else name="play" :size="15" />
          {{ running ? "请求中…" : "发送测试" }}
        </button>
      </div>
      <p v-if="disabledReason" class="debug-inline-error">{{ disabledReason }}</p>
      <div v-if="showRequestDetails" class="request-line">
        <span class="method-tag" :class="source.method.toLowerCase()">{{ source.method }}</span>
        <code :title="requestDetails.url">{{ requestDetails.url }}</code>
        <span class="request-origin">{{ exactRequest ? "实际请求" : "配置预览" }}</span>
      </div>
    </section>

    <section v-if="showRequestDetails" class="debug-request-inspector" aria-label="实际请求参数">
      <div class="debug-section-heading request-inspector-heading">
        <div>
          <span class="eyebrow">REQUEST DETAILS</span>
          <strong>实际请求参数</strong>
        </div>
        <span class="debug-limit">Query · Body · Headers · Transform</span>
      </div>
      <div class="debug-tabs" role="tablist" aria-label="请求详情视图">
        <button type="button" :class="{ active: requestTab === 'query' }" @click="requestTab = 'query'">Query <span>{{ queryCount }}</span></button>
        <button type="button" :class="{ active: requestTab === 'body' }" @click="requestTab = 'body'">Body</button>
        <button type="button" :class="{ active: requestTab === 'headers' }" @click="requestTab = 'headers'">Headers <span>{{ headerCount }}</span></button>
        <button type="button" :class="{ active: requestTab === 'transform' }" @click="requestTab = 'transform'">transform(payload, $, context)</button>
        <button class="icon-button" type="button" aria-label="复制当前请求内容" @click="copyText(requestText)">
          <ConsoleIcon name="copy" :size="14" />
        </button>
      </div>
      <div class="code-window request-code-window">
        <div class="code-window-header"><span><i></i><i></i><i></i></span><span>{{ requestFileName }}</span><small>{{ exactRequest ? "ACTUAL" : "PREVIEW" }}</small></div>
        <pre tabindex="0">{{ requestText }}</pre>
      </div>
      <p v-if="!exactRequest" class="field-hint">发送测试后，此处会切换为服务端最终渲染并实际发出的请求参数；敏感凭据会自动脱敏。</p>
    </section>

    <section class="debug-response-section" aria-label="测试响应">
      <div class="debug-section-heading response-heading">
        <div>
          <span class="eyebrow">RESPONSE</span>
          <strong>响应检查</strong>
        </div>
        <div v-if="report" class="response-meta">
          <span v-if="report.httpStatus" class="response-chip" :class="statusClass">HTTP {{ report.httpStatus }}</span>
          <span v-if="responseContentType" class="response-chip">{{ responseContentType }}</span>
          <span class="response-chip">{{ report.elapsedMs }} ms</span>
        </div>
      </div>

      <div v-if="report?.state === 'error'" class="probe-failure-card" role="alert">
        <div class="probe-failure-title">
          <strong>来源测试失败</strong>
          <span v-if="report.httpStatus">HTTP {{ report.httpStatus }}</span>
        </div>
        <p>{{ report.message || "来源请求未完成" }}</p>
        <p v-if="latestTrace?.error" class="probe-failure-detail">{{ latestTrace.error }}</p>
        <small v-if="latestTrace?.stage === 'request'">请求阶段失败，transform(payload, $, context) 未执行。</small>
      </div>

      <div class="debug-tabs" role="tablist" aria-label="测试响应视图">
        <button type="button" :class="{ active: responseTab === 'unified' }" @click="responseTab = 'unified'">统一结果 <span>{{ report?.results.length || 0 }}</span></button>
        <button type="button" :class="{ active: responseTab === 'raw' }" @click="responseTab = 'raw'">原始响应</button>
        <button class="icon-button" type="button" aria-label="复制当前响应内容" @click="copyText(responseText)">
          <ConsoleIcon name="copy" :size="14" />
        </button>
      </div>

      <div v-if="responseTab === 'raw' && isHtmlResponse" class="raw-view-toolbar" role="group" aria-label="HTML 响应视图">
        <span class="raw-view-label"><ConsoleIcon name="code" :size="14" />检测到 HTML 响应</span>
        <div class="raw-view-switcher">
          <button type="button" :class="{ active: rawView === 'preview' }" @click="rawView = 'preview'">安全预览</button>
          <button type="button" :class="{ active: rawView === 'source' }" @click="rawView = 'source'">源代码</button>
        </div>
      </div>

      <div class="code-window response-code-window" :class="{ 'html-preview-window': responseTab === 'raw' && isHtmlResponse && rawView === 'preview' }">
        <div class="code-window-header"><span><i></i><i></i><i></i></span><span>{{ responseFileName }}</span><small>{{ report?.httpStatus ? `HTTP ${report.httpStatus}` : "READY" }}</small></div>
        <iframe
          v-if="responseTab === 'raw' && isHtmlResponse && rawView === 'preview' && report"
          class="html-response-preview"
          title="来源 HTML 响应安全预览"
          :srcdoc="safeHtmlPreview"
          sandbox=""
          referrerpolicy="no-referrer"
        ></iframe>
        <pre v-else-if="report" tabindex="0">{{ responseText }}</pre>
        <div v-else class="code-empty"><ConsoleIcon name="code" :size="30" /><strong>等待响应</strong><p>点击「发送测试」，在这里检查来源数据和解析结果。</p></div>
      </div>
      <p v-if="error" class="debug-inline-error response-error">{{ error }}</p>
      <p v-else-if="report" class="field-hint" :class="`probe-${report.state}`">{{ report.message }}</p>
      <p v-if="responseTab === 'raw' && isHtmlResponse && rawView === 'preview'" class="field-hint preview-safety-note"><ConsoleIcon name="shield" :size="14" />预览运行在无脚本 sandbox 中。</p>
      <p v-if="report?.rawTruncated && responseTab === 'raw'" class="field-hint">原始响应预览已截断；统一结果使用完整响应解析。</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import ConsoleIcon from "./ConsoleIcon.vue";
import type { ProbeRequestDetails, SourceDefinition, SourceProbe } from "../../types/source";
import { buildSourceRequestPreview } from "../../utils/sourceDebugUrl";

const props = withDefaults(defineProps<{
  source: SourceDefinition;
  report?: SourceProbe;
  keyword: string;
  running?: boolean;
  error?: string;
  disabledReason?: string;
  /** Hide URL and request payload details when the panel is embedded in the editor. */
  showRequestDetails?: boolean;
  embedded?: boolean;
}>(), {
  report: undefined,
  running: false,
  error: "",
  disabledReason: "",
  showRequestDetails: true,
  embedded: false,
});

defineEmits<{
  send: [];
  "update:keyword": [value: string];
}>();

const instanceId = useId();
const keywordInputId = `source-debug-keyword-${instanceId.replace(/[^a-z0-9_-]/gi, "")}`;
const requestTab = ref<"query" | "body" | "headers" | "transform">("query");
const responseTab = ref<"unified" | "raw">("unified");
const rawView = ref<"preview" | "source">("preview");

const showRequestDetails = computed(() => props.showRequestDetails);
const canSend = computed(() => !props.running && !!props.keyword.trim() && !props.disabledReason);
const exactRequest = computed<ProbeRequestDetails | undefined>(() => {
  const traces = props.report?.traces || [];
  return [...traces].reverse().find((trace) => trace.stage === "request" && trace.request)?.request
    || [...traces].reverse().find((trace) => trace.request)?.request;
});
const previewRequest = computed<ProbeRequestDetails>(() => {
  try {
    return buildSourceRequestPreview(props.source, props.keyword);
  } catch {
    return { url: props.source.url || "// 请求地址尚未配置", query: {}, headers: {} };
  }
});
const requestDetails = computed(() => exactRequest.value || previewRequest.value);
const queryCount = computed(() => Object.keys(requestDetails.value.query || {}).length);
const headerCount = computed(() => Object.keys(requestDetails.value.headers || {}).length);
const transformText = computed(() => props.source.transform?.trim() || "// 未配置 transform(payload, $, context)，当前使用字段映射解析响应。\nfunction transform(payload, $, context) {\n  return [];\n}");
const requestText = computed(() => {
  if (requestTab.value === "transform") return transformText.value;
  if (requestTab.value === "body") return formatJson(requestDetails.value.body ?? null);
  return formatJson(requestTab.value === "headers" ? requestDetails.value.headers : requestDetails.value.query);
});
const requestFileName = computed(() => requestTab.value === "transform" ? "transform.js" : `request.${requestTab.value}.json`);
const responseText = computed(() => responseTab.value === "raw"
  ? props.report?.raw || "// 未取得响应体"
  : formatJson(props.report?.results || []));
const responseFileName = computed(() => responseTab.value === "raw"
  ? isHtmlResponse.value && rawView.value === "preview" ? "response.preview.html" : "response.raw"
  : "results.json");
const responseContentType = computed(() => [...(props.report?.traces || [])].reverse().find((trace) => trace.contentType)?.contentType || "");
const latestTrace = computed(() => [...(props.report?.traces || [])].reverse().find((trace) => trace.error) || props.report?.traces?.[props.report.traces.length - 1]);
const isHtmlResponse = computed(() => /(?:text\/html|application\/xhtml\+xml)/i.test(responseContentType.value) || (!responseContentType.value && props.source.format === "html"));
const statusClass = computed(() => props.report?.state === "available" ? "success" : props.report?.state === "warning" ? "warning" : "error");
const safeHtmlPreview = computed(() => sanitizeHtmlForPreview(props.report?.raw || ""));

watch(() => props.report, () => {
  responseTab.value = "unified";
  rawView.value = "preview";
});

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

async function copyText(text: string) {
  await navigator.clipboard?.writeText(text);
}

function sanitizeHtmlForPreview(html: string): string {
  if (!html) return '<p style="font:14px system-ui;color:#8b8f98">暂无 HTML 响应</p>';
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
  style.textContent = "html{background:#fff;color:#20242b}body{margin:20px;font:14px/1.6 system-ui;overflow-wrap:anywhere}img{max-width:100%;height:auto}pre{white-space:pre-wrap;word-break:break-word}a{color:#315edb}table{max-width:100%;border-collapse:collapse}td,th{border:1px solid #dfe3ea;padding:6px 8px}";
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
</script>

<style scoped>
/* Let long URLs and preformatted payloads scroll inside their own code window,
   rather than setting the grid track's intrinsic minimum width. */
.source-debug-panel { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; gap: 16px; }
.source-debug-panel > section { min-width: 0; overflow-wrap: anywhere; }
.debug-controls > input { flex: 1; min-width: 0; }
.debug-controls > button { flex: 0 0 auto; }
.debug-request-card,
.debug-request-inspector,
.debug-response-section { border: 1px solid var(--line, #e4e6eb); border-radius: 16px; padding: 16px; background: color-mix(in srgb, var(--panel, #fff) 94%, #f4f6fb); }
.embedded .debug-request-card,
.embedded .debug-request-inspector,
.embedded .debug-response-section { border-radius: 12px; background: #fff; }
.debug-section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.debug-section-heading > div:first-child { display: grid; gap: 3px; }
.debug-section-heading strong { font-size: 15px; }
.debug-limit, .response-chip, .request-origin { color: #8a8f99; font-size: 11px; white-space: nowrap; }
.request-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
.request-line .method-tag, .request-origin { flex: 0 0 auto; white-space: nowrap; }
.request-line code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.request-origin { margin-left: auto; padding: 3px 7px; border-radius: 999px; background: #eef2f7; }
.debug-tabs { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-width: 0; margin-bottom: 8px; }
.debug-tabs > button:not(.icon-button) { border: 0; border-radius: 8px; padding: 7px 10px; color: #6b7280; background: transparent; font: inherit; font-size: 12px; max-width: 100%; white-space: normal; overflow-wrap: anywhere; cursor: pointer; }
.debug-tabs > button.active { color: #315edb; background: #eef3ff; font-weight: 700; }
.debug-tabs > button span { margin-left: 3px; color: #94a3b8; }
.debug-tabs .icon-button { margin-left: auto; flex: 0 0 auto; }
.code-window pre { min-height: 128px; max-height: 320px; overflow: auto; }
.response-code-window pre { min-height: 280px; }
.response-meta { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.response-chip { min-width: 0; max-width: 100%; white-space: normal; border: 1px solid #e1e4ea; border-radius: 999px; padding: 4px 8px; background: #fff; }
.response-chip.success { color: #168a5b; border-color: #b9e5d0; background: #f1fbf6; }
.response-chip.error { color: #c84b43; border-color: #f1c4c0; background: #fff5f4; }
.response-chip.warning { color: #a16b14; border-color: #ecd9aa; background: #fffaf0; }
.raw-view-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 11px; border: 1px solid #e3e6ec; border-bottom: 0; border-radius: 10px 10px 0 0; background: #fafbfc; }
.raw-view-label { display: inline-flex; align-items: center; gap: 6px; color: #4e5969; font-size: 12px; }
.raw-view-switcher { display: inline-flex; padding: 2px; border-radius: 8px; background: #eceff4; }
.raw-view-switcher button { border: 0; border-radius: 6px; padding: 5px 9px; color: #737b88; background: transparent; font: inherit; font-size: 12px; cursor: pointer; }
.raw-view-switcher button.active { color: #28334a; background: #fff; box-shadow: 0 1px 3px #1d29391a; }
.html-preview-window { border-radius: 0 0 10px 10px; }
.html-response-preview { display: block; width: 100%; min-height: 330px; border: 0; background: #fff; }
.preview-safety-note { display: flex; align-items: center; gap: 5px; color: #6f7784; }
.debug-inline-error { margin: 9px 0 0; color: #c2413b; font-size: 12px; }
.response-error { margin-top: 12px; }
.probe-failure-card { margin: 0 0 12px; padding: 12px 14px; border: 1px solid #f0b9b4; border-radius: 10px; background: #fff6f5; color: #8f2f2a; }
.probe-failure-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.probe-failure-title span { font-size: 12px; font-weight: 700; }
.probe-failure-card p { margin: 6px 0 0; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.probe-failure-card .probe-failure-detail { color: #a9443d; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.probe-failure-card small { display: block; margin-top: 8px; color: #a16b14; }
.probe-available { color: #168a5b; }
.probe-warning { color: #a16b14; }
.probe-error { color: #c84b43; }
@media (max-width: 560px) {
  .debug-controls { flex-wrap: wrap; }
  .debug-controls > input { flex-basis: 100%; }
  .debug-section-heading { display: block; }
  .debug-limit, .response-meta { display: flex; margin-top: 8px; justify-content: flex-start; }
  .raw-view-toolbar { align-items: flex-start; flex-direction: column; }
}
</style>
