<template>
  <Teleport to="body">
    <dialog ref="dialog" class="tg-debug-dialog" aria-labelledby="tg-debug-title" @close="$emit('close')" @click="closeOnBackdrop">
      <header class="debug-header">
        <div><p class="eyebrow">TELEGRAM / DEBUG</p><h2 id="tg-debug-title">调试报文 · @{{ channel }}</h2><p>本页单频道诊断，不保存或改变频道配置。</p></div>
        <button class="close-button" type="button" aria-label="关闭频道调试" @click="dialog?.close()">关闭</button>
      </header>
      <div class="debug-body">
        <form class="debug-form" @submit.prevent="submit">
          <label>调试关键词<input v-model="keyword" maxlength="100" required :disabled="busy" placeholder="输入关键词" /></label>
          <label>最多结果<select v-model.number="limit" aria-label="最多结果" :disabled="busy"><option :value="10">10 条</option><option :value="20">20 条</option><option :value="50">50 条</option></select></label>
          <div class="form-actions">
            <button class="run-button" type="submit" :disabled="busy || !keyword.trim()">{{ running ? '调试中…' : '发送调试请求' }}</button>
            <button class="open-tab-button" type="button" title="在浏览器新标签页通过 Jina 镜像打开该频道的公开页面，不经过本站服务端，也不依赖调试请求" @click="openChannelInNewTab">新标签打开</button>
          </div>
        </form>
        <p v-if="running" class="notice" role="status">正在请求 @{{ channel }}。关闭抽屉不会取消已提交的检测，结果会保留在本页。</p>
        <p v-else-if="busy" class="notice" role="status">其他频道正在检测，请稍后重试。</p>
        <p v-if="error" class="notice failure" role="alert">本次请求失败：{{ error }}</p>
        <section v-if="report" class="summary" aria-label="频道调试结果">
          <div class="metrics"><strong>{{ stateLabel }}</strong><span>HTTP {{ report.httpStatus ?? '未取得' }}</span><span>{{ report.elapsedMs }} ms</span><span>{{ report.results.length }} 条结果</span></div>
          <p>{{ report.message }}</p><small>关键词：{{ report.keyword }} · {{ report.checkedAt }} · {{ report.route === 'jina' ? 'Jina 备用线路' : report.route === 'telegram' ? 'Telegram 直连' : '无成功线路' }}</small>
        </section>
        <TelegramStageCompare
          v-if="report"
          :stages="report.stages"
          :failure-kind="report.failureKind ?? null"
          :elapsed-ms="report.elapsedMs"
        />
        <div class="report-tabs" role="group" aria-label="报文视图">
          <button v-for="item in tabs" :key="item.key" type="button" :aria-pressed="tab === item.key" @click="tab = item.key">{{ item.label }}</button>
        </div>
        <section v-if="tab === 'input'" class="payload-section">
          <div class="section-head">
            <h3>接口入参 <span>POST /api/tg/probe</span></h3>
            <TelegramCopyButton compact :text="json(request || { channel, keyword: keyword.trim(), limit })" label="复制入参" />
          </div>
          <p>{{ request ? '最近一次已发送参数的快照。编辑上方表单不会改变此报文。' : '待发送参数预览，尚未发起请求。' }}</p>
          <pre tabindex="0" aria-label="接口入参报文">{{ json(request || { channel, keyword: keyword.trim(), limit }) }}</pre>
        </section>
        <section v-else-if="tab === 'output'" class="payload-section">
          <div class="section-head">
            <h3>接口出参 <span>JSON · 与诊断接口返回一致</span></h3>
            <TelegramCopyButton v-if="report" compact :text="json(report)" label="复制出参 JSON" />
          </div>
          <pre v-if="report" tabindex="0" aria-label="接口出参报文">{{ json(report) }}</pre>
          <p v-else class="empty">{{ running ? '等待本次接口响应…' : error ? '本次请求失败，未取得诊断结果。' : '尚无响应。点击「发送调试请求」开始检测。' }}</p>
        </section>
        <section v-else-if="tab === 'results'" class="payload-section">
          <h3>统一结果 <span>SearchResult[]</span></h3>
          <pre v-if="report" tabindex="0" aria-label="统一结果报文">{{ json(report.results) }}</pre>
          <p v-else class="empty">{{ running ? '等待解析结果…' : '尚无本次解析结果。' }}</p>
        </section>
        <section v-else class="payload-section">
          <h3>上游原始报文 <span>包含直连和备用线路尝试</span></h3>
          <p v-if="!report" class="empty">{{ running ? '等待上游报文…' : '发送请求后，可查看每次尝试的请求头、响应头和原始正文。' }}</p>
          <template v-else>
            <label v-if="report.attempts.length" class="attempt-selector">上游请求<select v-model.number="attemptIndex" aria-label="上游请求"><option v-for="(attempt, index) in report.attempts" :key="index" :value="index">{{ index + 1 }} · {{ attempt.route === 'telegram' ? 'Telegram 直连' : 'Jina 备用' }} · HTTP {{ attempt.response?.status ?? 'ERR' }} · {{ attempt.elapsedMs }} ms</option></select></label>
            <p v-if="attempt?.error" class="notice failure">{{ attempt.error }}</p>
            <h4>原始请求</h4><pre tabindex="0" aria-label="上游原始请求">{{ json(attempt?.request || report.upstreamRequest) }}</pre>
            <h4>响应状态与响应头</h4><pre tabindex="0" aria-label="上游响应头">{{ json(response ? { status: response.status, headers: response.headers, bodyLength: response.bodyLength, bodyTruncated: response.bodyTruncated } : null) }}</pre>
            <h4>原始正文 <span>格式化 / 源码 / 沙箱渲染，均不执行脚本</span></h4>
            <TelegramRawBodyView
              :body="response?.body || ''"
              :keyword="report.keyword"
              :body-length="response?.bodyLength ?? null"
              :truncated="!!response?.bodyTruncated"
              :base-url="baseUrl"
              :frame-title="`@${channel} 上游响应渲染`"
            />
          </template>
        </section>
      </div>
    </dialog>
  </Teleport>
</template>
<script setup lang="ts">
import type { TgProbeResult } from "../../server/core/services/tg";
import { buildTgSourceUrl, type TgSourceUrlSettings } from "../../utils/tgSourceUrl";
import TelegramCopyButton from "../telegram/TelegramCopyButton.vue";
import TelegramRawBodyView from "../telegram/TelegramRawBodyView.vue";
import TelegramStageCompare from "../telegram/TelegramStageCompare.vue";
const props = defineProps<{
  channel: string;
  initialKeyword: string;
  request?: { channel: string; keyword: string; limit: number };
  report?: TgProbeResult;
  error?: string;
  busy: boolean;
  running: boolean;
  sourceSettings?: TgSourceUrlSettings;
}>();
const emit = defineEmits<{ (event: "close"): void; (event: "run", options: { keyword: string; limit: number }): void }>();
const dialog = ref<HTMLDialogElement | null>(null);
const keyword = ref(props.request?.keyword ?? props.initialKeyword);
const limit = ref(props.request?.limit ?? 10);
const tabs = [
  { key: "input", label: "接口入参" }, { key: "output", label: "接口出参" },
  { key: "raw", label: "原始报文" }, { key: "results", label: "统一结果" },
] as const;
const tab = ref<(typeof tabs)[number]["key"]>(props.report ? "raw" : "input");
const attemptIndex = ref(0);
const attempt = computed(() => props.report?.attempts[attemptIndex.value]);
const response = computed(() => attempt.value ? attempt.value.response : props.report?.upstreamResponse);
const baseUrl = computed(() => attempt.value?.request.url || props.report?.upstreamRequest?.url || "");
function openChannelInNewTab() {
  const url = buildTgSourceUrl("jina", props.channel, keyword.value, undefined, props.sourceSettings);
  window.open(url, "_blank", "noopener");
}
const stateLabel = computed(() => ({ available: "可提取结果", warning: "需确认", error: "上游异常" })[props.report?.state || "warning"]);
watch(() => props.report, (value) => { if (value) attemptIndex.value = 0; });
function json(value: unknown) { return JSON.stringify(value, null, 2) ?? "null"; }
function submit() {
  if (props.busy || !keyword.value.trim()) return;
  emit("run", { keyword: keyword.value.trim(), limit: limit.value });
}
function closeOnBackdrop(event: MouseEvent) {
  const element = dialog.value;
  if (!element || event.target !== element) return;
  const rect = element.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) element.close();
}
let previousFocus: HTMLElement | null = null;
let previousOverflow = "";
onMounted(() => {
  previousFocus = document.activeElement as HTMLElement;
  previousOverflow = document.body.style.overflow;
  dialog.value?.showModal();
  document.body.style.overflow = "hidden";
});
onBeforeUnmount(() => {
  dialog.value?.close();
  document.body.style.overflow = previousOverflow;
  if (previousFocus?.isConnected) previousFocus.focus();
});
</script>
<style scoped>
.tg-debug-dialog { position: fixed; inset: 0 0 0 auto; margin: 0; width: min(800px, 100vw); max-width: 100vw; height: 100dvh; max-height: 100dvh; padding: 0; border: 0; background: #fff; color: #1e293b; box-shadow: -12px 0 50px #0f172a26; font: 14px/1.6 Inter, system-ui, sans-serif; box-sizing: border-box; }
.tg-debug-dialog[open] { display: flex; flex-direction: column; }
.tg-debug-dialog::backdrop { background: #0f172a66; backdrop-filter: blur(2px); }
.debug-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding: 24px; border-bottom: 1px solid #e2e8f0; }
.debug-header > div { min-width: 0; }
h2 { font-size: 20px; margin: 4px 0; overflow-wrap: anywhere; }
.debug-header p { margin: 0; font-size: 12px; color: #64748b; }
.eyebrow { letter-spacing: .1em; font-weight: 600; }
.debug-body { flex: 1; min-height: 0; overflow-y: auto; padding: 24px; display: flex; flex-direction: column; gap: 20px; }
button, input, select { min-height: 44px; border: 1px solid #cbd5e1; border-radius: 8px; font: inherit; background: white; color: #334155; box-sizing: border-box; }
button { padding: 8px 14px; cursor: pointer; }
button:disabled { opacity: .5; cursor: not-allowed; }
.close-button { flex-shrink: 0; }
button:hover:not(:disabled) { background: #f1f5f9; }
button:focus-visible, input:focus-visible, select:focus-visible, pre:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
.debug-form { display: grid; grid-template-columns: minmax(0, 1fr) 110px auto; align-items: end; gap: 12px; }
label { display: grid; gap: 6px; font-size: 12px; font-weight: 600; min-width: 0; }
input, select { padding: 8px 10px; width: 100%; min-width: 0; }
.run-button { color: white; background: #2563eb; border-color: #2563eb; font-weight: 600; }
.run-button:hover:not(:disabled) { background: #1d4ed8; }
.form-actions { display: flex; gap: 8px; }
.section-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
.section-head h3 { margin: 0; }
.notice, .summary { border: 1px solid #dbeafe; background: #eff6ff; border-radius: 10px; padding: 12px; margin: 0; font-size: 12px; }
.failure { border-color: #fecaca; background: #fef2f2; color: #991b1b; overflow-wrap: anywhere; }
.summary { color: #334155; }
.summary p { margin: 8px 0; }
.summary small { color: #64748b; overflow-wrap: anywhere; }
.metrics { display: flex; flex-wrap: wrap; gap: 12px; }
.report-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.report-tabs button { font-size: 12px; }
.report-tabs button[aria-pressed="true"] { border-color: #2563eb; color: #1d4ed8; background: #eff6ff; font-weight: 700; }
h3 { font-size: 14px; margin: 0 0 8px; } h3 span, h4 span { color: #64748b; font-size: 11px; font-weight: 400; }
h4 { font-size: 12px; margin: 18px 0 8px; }
.payload-section { min-width: 0; }
.payload-section > p { font-size: 12px; color: #64748b; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 16px; margin: 0; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; font: 12px/1.7 ui-monospace, monospace; max-height: 55vh; overflow: auto; }
.empty { border: 1px dashed #cbd5e1; border-radius: 10px; padding: 30px 16px; text-align: center; }
@media (max-width: 600px) { .debug-header, .debug-body { padding: 16px; } .debug-form { grid-template-columns: minmax(0, 1fr) 100px; } .form-actions { grid-column: 1 / -1; } .form-actions button { flex: 1; } h2 { font-size: 18px; } .report-tabs { gap: 4px; } .report-tabs button { flex: 1; padding: 8px 6px; white-space: nowrap; } }
</style>
