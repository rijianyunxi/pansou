<template>
  <dialog
    ref="dialog"
    class="source-dialog"
    :class="{ 'source-dialog-readonly': readonly }"
    aria-labelledby="editor-title"
    @close="$emit('close')"
    @click="onBackdrop"
  >
    <form class="editor-form" @submit.prevent="handleSubmit">
      <header class="editor-header">
        <div class="editor-title-wrap">
          <div class="editor-title-line">
            <span class="editor-kicker">SOURCE CONFIGURATION</span>
            <span class="editor-mode-badge" :class="{ readonly }">{{ readonly ? "只读" : "可编辑" }}</span>
          </div>
          <h2 id="editor-title">
            {{ readonly ? "来源详情" : source ? "编辑来源" : "新增来源" }}
          </h2>
          <p>{{ readonly ? "查看来源连接、请求参数与结果解析配置。" : "配置来源连接与解析规则，保存后将同步到来源目录。" }}</p>
        </div>
        <button
          type="button"
          class="icon-button editor-close-button"
          aria-label="关闭窗口"
          @click="dialog?.close()"
        >
          <ConsoleIcon name="close" />
        </button>
      </header>

      <div class="editor-content">
        <section class="editor-section editor-overview-section">
          <div class="editor-section-heading">
            <div>
              <strong>基础信息</strong>
              <p>定义来源身份、接入方式和主要请求地址。</p>
            </div>
            <span class="editor-section-index">01</span>
          </div>

          <div class="editor-grid editor-primary-grid">
            <label>
              <span class="editor-field-label">来源名称 <span class="required-marker">*</span></span>
              <input
                v-model="form.name"
                required
                maxlength="40"
                placeholder="例如：我的资源来源"
                :autofocus="!readonly"
                :readonly="readonly"
              />
            </label>

            <label>
              描述
              <input
                v-model="form.description"
                maxlength="100"
                :readonly="readonly"
                placeholder="描述来源用途或补充说明"
              />
            </label>
          </div>

          <div class="editor-grid editor-connection-grid">
            <label>
              请求方式
              <select v-model="form.method" :disabled="readonly">
                <option>GET</option>
                <option>POST</option>
              </select>
            </label>
            <label>
              响应格式
              <select v-model="form.format" :disabled="readonly">
                <option value="json">JSON</option>
                <option value="html">HTML</option>
              </select>
            </label>
          </div>

          <label class="editor-url-field">
            <span class="editor-field-label">请求地址 <span class="required-marker">*</span></span>
            <input
              v-model="form.url"
              required
              type="url"
              placeholder="https://api.example.com/search"
              maxlength="500"
              :readonly="readonly"
            />
          </label>
        </section>

      <details class="editor-advanced" open>
        <summary>请求参数</summary>
        <div class="editor-grid request-config-grid">
          <label>
            Query JSON
            <textarea
              v-model="requestQueryText"
              class="code-input"
              :readonly="readonly"
              rows="5"
              spellcheck="false"
              aria-describedby="request-config-help"
              placeholder='{"q":"{{keyword}}"}'
            ></textarea>
          </label>
          <label>
            Body JSON
            <textarea
              v-model="requestBodyText"
              class="code-input"
              :readonly="readonly"
              rows="5"
              spellcheck="false"
              aria-describedby="request-config-help"
              placeholder='{"keyword":"{{keyword}}"}'
            ></textarea>
          </label>
          <label>
            Headers JSON
            <textarea
              v-model="requestHeadersText"
              class="code-input"
              :readonly="readonly"
              rows="5"
              spellcheck="false"
              aria-describedby="request-config-help"
              placeholder='{"user-agent":"Mozilla/5.0"}'
            ></textarea>
          </label>
        </div>
        <p id="request-config-help" class="editor-help request-config-help">
          支持在 URL、Query、Body、Headers 中使用
          <code>&#123;&#123;keyword&#125;&#125;</code>，请求前会替换为当前搜索词。
        </p>
      </details>

      <details class="editor-function" open>
        <summary>结果解析</summary>
        <div class="function-field">
          <p id="transform-help" class="editor-help transform-help">
            <code>payload</code> 是接口响应内容；<code>$</code> 是 HTML 查询工具；<code>context</code> 提供 <code>keyword</code>、来源标识和响应格式等上下文。
            函数必须返回标准结果 JSON 数组，例如 <code>[{ title, links: [{ url }] }]</code>。请粘贴纯 JavaScript，不要包含 Markdown 链接标记。
          </p>
          <div class="function-toolbar">
            <span class="function-label">transform(payload, $, context)</span>
            <div class="function-file-actions" aria-label="结果解析文件操作">
              <button
                type="button"
                class="function-action-button"
                :disabled="readonly"
                @click="openTransformImport"
              >
                <ConsoleIcon name="upload" :size="14" />
                导入 JS
              </button>
              <button
                type="button"
                class="function-action-button"
                :disabled="!form.transform?.trim()"
                @click="exportTransform"
              >
                <ConsoleIcon name="download" :size="14" />
                导出 JS
              </button>
            </div>
          </div>
          <textarea
            id="upstream-transform"
            v-model="form.transform"
            class="code-input"
            :readonly="readonly"
            rows="14"
            spellcheck="false"
            aria-describedby="transform-help"
            placeholder="function transform(payload, $, context) {
  return [];
}"
          ></textarea>
          <input
            ref="transformImportInput"
            class="transform-file"
            type="file"
            accept=".js,.mjs,text/javascript"
            :disabled="readonly"
            @change="importTransform"
          />
        </div>
      </details>

      <details v-if="!readonly" class="editor-debugger" open>
        <summary>在线调试</summary>
        <p class="editor-help debugger-help">保存来源后输入关键词发送测试，查看来源返回的统一结果或原始响应。</p>
        <UpstreamDebugPanel
          :source="debugDraft.source"
          :report="debugReport"
          :keyword="debugKeyword"
          :running="debugRunning"
          :error="debugError"
          :disabled-reason="debugDraft.error"
          :show-request-details="false"
          embedded
          @send="testDraftSource"
          @update:keyword="debugKeyword = $event"
        />
      </details>

        <slot name="readonly-extra" />

        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      </div>

      <footer class="editor-footer">
        <template v-if="readonly">
          <button type="button" class="button secondary" @click="dialog?.close()">
            关闭
          </button>
          <button type="button" class="button secondary" @click="$emit('edit')">
            <ConsoleIcon name="edit" :size="15" />编辑来源
          </button>
          <button type="button" class="button secondary" :disabled="running" @click="$emit('debug')">
            <ConsoleIcon name="play" :size="15" />测试来源
          </button>
          <button type="button" class="button danger-button" @click="$emit('delete')">
            <ConsoleIcon name="trash" :size="15" />删除来源
          </button>
        </template>
        <template v-else>
          <button type="button" class="button secondary" @click="dialog?.close()">
            取消
          </button>
          <button type="submit" class="button primary">
            <ConsoleIcon name="check" />
            {{ source ? "保存来源" : "创建来源" }}
          </button>
        </template>
      </footer>
    </form>
  </dialog>
</template>

<script setup lang="ts">
import ConsoleIcon from "./ConsoleIcon.vue";
import UpstreamDebugPanel from "./UpstreamDebugPanel.vue";
import type { UpstreamDefinition, UpstreamProbe } from "../../types/source";

const props = defineProps<{
  source?: UpstreamDefinition | null;
  readonly?: boolean;
  running?: boolean;
}>();

type EditableUpstreamDefinition = UpstreamDefinition;

const emit = defineEmits<{
  close: [];
  save: [source: EditableUpstreamDefinition];
  edit: [];
  debug: [];
  delete: [];
}>();

const dialog = ref<HTMLDialogElement>();
const transformImportInput = ref<HTMLInputElement | null>(null);
const error = ref("");
const debugKeyword = ref("三体");
const debugReport = ref<UpstreamProbe>();
const debugRunning = ref(false);
const debugError = ref("");

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createBlankSource(): EditableUpstreamDefinition {
  return {
    id: "",
    name: "",
    url: "",
    description: "",
    method: "GET",
    format: "json",
    transform: "",
  };
}

function cloneSource(source: UpstreamDefinition): EditableUpstreamDefinition {
  const cloned = cloneJson(source) as EditableUpstreamDefinition;
  // 编辑时只展示数据库中已保存的配置，不从任何内置来源回填请求或解析脚本。
  return cloned;
}

const form = reactive<EditableUpstreamDefinition>(
  props.source ? cloneSource(props.source) : createBlankSource(),
);

function stringifyRequestValue(value: unknown): string {
  if (value === undefined) return "{}";
  return JSON.stringify(value, null, 2) ?? "{}";
}

const requestQueryText = ref(
  stringifyRequestValue(form.request?.query),
);
const requestBodyText = ref(
  stringifyRequestValue(form.request?.body),
);
const requestHeadersText = ref(
  stringifyRequestValue(form.request?.headers),
);

function parseEditorJson(text: string, label: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}必须是有效 JSON。`);
  }
}

const debugDraft = computed<{ source: EditableUpstreamDefinition; error: string }>(() => {
  const draft = cloneJson(form);
  try {
    if (!draft.url.trim()) throw new Error("请先填写请求地址。");
    const query = parseEditorJson(requestQueryText.value, "Query");
    const body = parseEditorJson(requestBodyText.value, "Body");
    const headers = parseEditorJson(requestHeadersText.value, "Headers");
    if (headers !== undefined && (
      !headers || typeof headers !== "object" || Array.isArray(headers)
      || Object.values(headers as Record<string, unknown>).some((value) => typeof value !== "string")
    )) throw new Error("Headers 必须是字符串键值 JSON。");
    if (!props.source?.id) throw new Error("请先保存来源后再测试。");
    draft.id = props.source.id;
    draft.name ||= "已保存来源";
    draft.request = {
      ...(draft.request || {}),
      query: query as Record<string, unknown> | undefined,
      body,
      headers: headers as Record<string, string> | undefined,
    };
    if (draft.method === "GET" && draft.request) delete draft.request.body;
    return { source: draft, error: "" };
  } catch (reason) {
    return {
      source: draft,
      error: reason instanceof Error ? reason.message : String(reason),
    };
  }
});

async function testDraftSource() {
  if (debugRunning.value || debugDraft.value.error) return;
  debugRunning.value = true;
  debugError.value = "";
  debugReport.value = undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 16_000);
  try {
    debugReport.value = await $fetch<UpstreamProbe>("/api/upstreams/test", {
      method: "POST",
      body: { sourceId: props.source!.id, kw: debugKeyword.value.trim() },
      signal: controller.signal,
      retry: 0,
    });
  } catch (reason: any) {
    debugError.value = reason?.data?.statusMessage || reason?.message || "来源测试失败";
  } finally {
    clearTimeout(timer);
    debugRunning.value = false;
  }
}

function syncEditor(source?: UpstreamDefinition | null) {
  const next = source ? cloneSource(source) : createBlankSource();
  for (const key of Object.keys(form) as Array<keyof EditableUpstreamDefinition>) {
    if (!(key in next)) delete form[key];
  }
  Object.assign(form, next);
  requestQueryText.value = stringifyRequestValue(form.request?.query);
  requestBodyText.value = stringifyRequestValue(form.request?.body);
  requestHeadersText.value = stringifyRequestValue(form.request?.headers);
  error.value = "";
  debugError.value = "";
  debugReport.value = undefined;
}

watch(() => props.source, syncEditor);

onMounted(() => dialog.value?.showModal());

function openTransformImport() {
  transformImportInput.value?.click();
}

function exportTransform() {
  const blob = new Blob([form.transform || ""], {
    type: "text/javascript;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${form.id || "upstream-transform"}.js`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function importTransform(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const code = await file.text();
  if (code.trim()) {
    form.transform = code;
    error.value = "";
  }
}

function onBackdrop(event: MouseEvent) {
  if (!dialog.value || event.target !== dialog.value) return;
  const rect = dialog.value.getBoundingClientRect();
  if (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  ) {
    dialog.value.close();
  }
}

function handleSubmit() {
  if (props.readonly) return;
  save();
}

function save() {
  try {
    const url = new URL(form.url);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error();
    }
  } catch {
    error.value = "请输入不含账号凭据的 HTTPS 地址。";
    return;
  }

  if (!form.name.trim()) {
    error.value = "请填写来源名称。";
    return;
  }

  const parseJson = (text: string, label: string): unknown => {
    if (!text.trim()) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${label}必须是有效 JSON。`);
    }
  };

  try {
    const query = parseJson(requestQueryText.value, "Query");
    const body = parseJson(requestBodyText.value, "Body");
    const headers = parseJson(requestHeadersText.value, "Headers");
    if (
      headers !== undefined &&
      (!headers ||
        typeof headers !== "object" ||
        Array.isArray(headers) ||
        Object.values(headers as Record<string, unknown>).some(
          (value) => typeof value !== "string",
        ))
    ) {
      throw new Error("Headers 必须是字符串键值 JSON。");
    }
    form.request = {
      ...(form.request || {}),
      query: query as Record<string, unknown> | undefined,
      body,
      headers: headers as Record<string, string> | undefined,
    };
    if (form.method === "GET") delete form.request.body;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason);
    return;
  }

  if (!form.id) form.id = `custom-${crypto.randomUUID()}`;
  form.name = form.name.trim();
  emit("save", JSON.parse(JSON.stringify(form)));
  dialog.value?.close();
}
</script>

<style scoped>
.source-dialog {
  width: min(1120px, calc(100vw - 48px));
  max-width: none;
  max-height: min(92dvh, 980px);
  overflow: hidden;
  border-radius: 18px;
}

.source-dialog-readonly {
  width: min(1180px, calc(100vw - 48px));
}

.editor-form {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  max-height: min(92dvh, 980px);
  overflow: hidden;
  padding: 0;
}

.editor-header {
  position: relative;
  z-index: 3;
  display: flex;
  flex: 0 0 auto;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  margin: 0;
  padding: 25px 30px 22px;
  border-bottom: 1px solid #e7edf5;
  background:
    radial-gradient(circle at 88% 0%, rgba(219, 234, 254, 0.62), transparent 36%),
    linear-gradient(180deg, #ffffff 0%, #fbfdff 100%);
}

.editor-title-wrap {
  min-width: 0;
}

.editor-title-line {
  display: flex;
  align-items: center;
  gap: 10px;
}

.editor-title-wrap h2 {
  margin: 7px 0 0;
}

.editor-title-wrap p {
  margin: 7px 0 0;
  color: #64748b;
  font-size: 12px;
  line-height: 1.6;
}

.editor-mode-badge {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  padding: 2px 8px;
  border: 1px solid #bfdbfe;
  border-radius: 999px;
  background: #eff6ff;
  color: #2563eb;
  font-size: 10px;
  font-weight: 700;
}

.editor-mode-badge.readonly {
  border-color: #d9e2ec;
  background: #f1f5f9;
  color: #64748b;
}

.editor-close-button {
  margin-top: 1px;
}

.editor-content {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 24px 30px 30px;
  scrollbar-gutter: stable;
}

.editor-section {
  padding: 20px;
  border: 1px solid #e1e8f1;
  border-radius: 13px;
  background: #fff;
}

.editor-section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 18px;
}

.editor-section-heading strong {
  display: block;
  color: #1e293b;
  font-size: 13px;
  font-weight: 750;
}

.editor-section-heading p {
  margin: 4px 0 0;
  color: #7b899b;
  font-size: 11px;
  line-height: 1.55;
}

.editor-section-index {
  color: #bfdbfe;
  font: 700 18px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
}

.editor-form label {
  position: relative;
}

.editor-field-label {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.editor-primary-grid {
  grid-template-columns: minmax(220px, 0.8fr) minmax(320px, 1.2fr);
}

.editor-connection-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
  align-items: end;
}

.editor-url-field {
  margin-bottom: 0 !important;
}

.editor-advanced,
.editor-function,
.editor-debugger {
  margin-top: 16px;
  padding: 17px 18px 18px;
  border: 1px solid #e1e8f1;
  border-radius: 13px;
  background: #f8fafc;
}

.editor-advanced summary,
.editor-function summary,
.editor-debugger summary {
  color: #334155;
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
  list-style-position: inside;
}

.editor-advanced[open] summary,
.editor-function[open] summary,
.editor-debugger[open] summary {
  margin-bottom: 13px;
}

.request-config-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  align-items: start;
}

.request-config-grid label {
  margin-bottom: 0;
}

.request-config-grid textarea {
  min-height: 124px;
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #27354f;
  border-radius: 8px;
  background: #0f172a;
  color: #dbeafe;
  caret-color: #93c5fd;
  font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
  padding: 12px;
  tab-size: 2;
  resize: vertical;
}

.request-config-grid textarea::placeholder,
.function-field textarea::placeholder {
  color: #7c8aa5;
  opacity: 1;
}

.debugger-help { margin-bottom: 14px !important; }

.editor-debugger { background: #f5f8ff; }

.editor-help {
  margin: 0;
  color: #64748b;
  font-size: 11px;
  line-height: 1.7;
}

.editor-help code {
  padding: 1px 4px;
  border-radius: 4px;
  background: #e2e8f0;
  color: #334155;
  font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
}

.request-config-help {
  margin-top: 10px;
}

.transform-help {
  margin-bottom: 2px;
}

.editor-function {
  display: grid;
  gap: 0;
  margin-top: 14px;
  padding: 13px 14px 14px;
}

.function-field {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.function-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  min-width: 0;
}

.function-label {
  position: static;
  min-width: 0;
  overflow-wrap: anywhere;
  color: #475569;
  font-size: 12px;
  font-weight: 650;
}

.function-file-actions {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
}

.function-action-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-height: 28px;
  padding: 4px 9px;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  background: #fff;
  color: #2563eb;
  cursor: pointer;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}

.function-action-button:hover:not(:disabled) {
  border-color: #93c5fd;
  background: #eff6ff;
}

.function-action-button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.function-field textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 250px;
  padding: 12px;
  border: 1px solid #27354f;
  border-radius: 8px;
  color: #dbeafe;
  background: #0f172a;
  caret-color: #93c5fd;
  font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
  tab-size: 2;
  resize: vertical;
}

.function-field textarea:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}

.transform-file {
  display: none;
}

.editor-form .editor-footer {
  position: relative;
  z-index: 3;
  display: flex;
  flex: 0 0 auto;
  justify-content: flex-end;
  gap: 9px;
  margin: 0;
  padding: 16px 30px;
  border-top: 1px solid #e7edf5;
  background: rgba(255, 255, 255, 0.96);
  box-shadow: 0 -10px 28px rgba(30, 64, 110, 0.045);
  backdrop-filter: blur(10px);
}

@media (max-width: 980px) {
  .source-dialog,
  .source-dialog-readonly {
    width: calc(100vw - 32px);
  }

  .editor-primary-grid,
  .request-config-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .editor-connection-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .request-config-grid label:last-child {
    grid-column: 1 / -1;
  }
}

@media (max-width: 600px) {
  .source-dialog,
  .source-dialog-readonly {
    width: 100vw;
    max-width: 100vw;
    max-height: 100dvh;
    margin: 0;
    border: 0;
    border-radius: 0;
  }

  .editor-form {
    max-height: 100dvh;
  }

  .editor-header {
    padding: 20px 18px 17px;
  }

  .editor-content {
    padding: 18px;
  }

  .editor-section {
    padding: 16px;
  }

  .editor-primary-grid,
  .editor-connection-grid,
  .request-config-grid,

  .request-config-grid label:last-child {
    grid-column: auto;
  }

  .editor-form .editor-footer {
    flex-wrap: wrap;
    padding: 13px 18px;
  }

  .function-toolbar {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
  }

  .function-file-actions {
    width: 100%;
  }

  .function-action-button {
    flex: 1;
  }
}
</style>
