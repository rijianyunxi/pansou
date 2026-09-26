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
            <label>
              优先级
              <input
                v-model.number="form.priority"
                type="number"
                min="0"
                max="999"
                step="1"
                :readonly="readonly"
                aria-describedby="priority-help"
              />
              <small id="priority-help" class="editor-field-hint">数值越小越优先进入搜索队列，0 最先起跑</small>
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
        <div class="request-config-grid">
          <div class="request-tabs" role="tablist" aria-label="请求参数类型">
            <button type="button" role="tab" :aria-selected="requestTab === 'query'" :class="{ active: requestTab === 'query' }" @click="requestTab = 'query'">Query</button>
            <button type="button" role="tab" :aria-selected="requestTab === 'body'" :class="{ active: requestTab === 'body' }" @click="requestTab = 'body'">Body</button>
            <button type="button" role="tab" :aria-selected="requestTab === 'headers'" :class="{ active: requestTab === 'headers' }" @click="requestTab = 'headers'">Headers</button>
          </div>

          <section v-if="requestTab === 'query'" class="request-tab-panel" role="tabpanel">
            <div class="request-fields" aria-label="Query 参数字段">
              <div class="request-fields-toolbar">
                <span>Query 参数</span>
                <button type="button" class="button secondary small" :disabled="readonly" @click="addRequestField(queryFields)">添加字段</button>
              </div>
              <div v-if="!queryFields.length" class="request-fields-empty">暂无 Query 字段</div>
              <div v-for="field in queryFields" :key="field.id" class="request-field-row">
                <input v-model="field.key" :readonly="readonly" placeholder="key" aria-label="Query 字段名" />
                <input v-model="field.value" :readonly="readonly" placeholder="value，可使用 {{keyword}}" aria-label="Query 字段值" />
                <button type="button" class="request-field-remove" :disabled="readonly" aria-label="删除 Query 字段" @click="removeRequestField(queryFields, field.id)">删除</button>
              </div>
            </div>
          </section>

          <section v-else-if="requestTab === 'body'" class="request-tab-panel" role="tabpanel">
            <div class="request-fields" aria-label="Body 参数字段">
              <div class="request-fields-toolbar">
                <span>Body 参数（POST 请求使用）</span>
                <button type="button" class="button secondary small" :disabled="readonly || form.method !== 'POST'" @click="addRequestField(bodyFields)">添加字段</button>
              </div>
              <div v-if="!bodyFields.length" class="request-fields-empty">暂无 Body 字段</div>
              <div v-for="field in bodyFields" :key="field.id" class="request-field-row request-field-row-body">
                <input v-model="field.key" :readonly="readonly || form.method !== 'POST'" placeholder="key" aria-label="Body 字段名" />
                <textarea v-model="field.value" :readonly="readonly || form.method !== 'POST'" rows="2" placeholder="value，可使用 {{keyword}} 或 JSON" aria-label="Body 字段值"></textarea>
                <button type="button" class="request-field-remove" :disabled="readonly || form.method !== 'POST'" aria-label="删除 Body 字段" @click="removeRequestField(bodyFields, field.id)">删除</button>
              </div>
            </div>
          </section>

          <section v-else class="request-tab-panel" role="tabpanel">
            <div class="request-fields" aria-label="Headers 参数字段">
              <div class="request-fields-toolbar">
                <span>Headers 参数</span>
                <button type="button" class="button secondary small" :disabled="readonly" @click="addRequestField(headerFields)">添加字段</button>
              </div>
              <div v-if="!headerFields.length" class="request-fields-empty">暂无 Headers 字段</div>
              <div v-for="field in headerFields" :key="field.id" class="request-field-row">
                <input v-model="field.key" :readonly="readonly" placeholder="key" aria-label="Header 字段名" />
                <input v-model="field.value" :readonly="readonly" placeholder="value" aria-label="Header 字段值" />
                <button type="button" class="request-field-remove" :disabled="readonly" aria-label="删除 Header 字段" @click="removeRequestField(headerFields, field.id)">删除</button>
              </div>
            </div>
          </section>
        </div>
        <p id="request-config-help" class="editor-help request-config-help">
          支持在 URL、Query、Body、Headers 中使用
          <code>&#123;&#123;keyword&#125;&#125;</code>，请求前会替换为当前搜索词；value 填写有效 JSON 时会自动识别为对象、数组、数字或布尔值。
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
                @click="copyTransformPrompt"
              >
                <ConsoleIcon name="copy" :size="14" />
                {{ promptCopyState === "copied" ? "已复制提示词" : "复制 AI 提示词" }}
              </button>
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
            id="source-transform"
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
        <SourceDebugPanel
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
import SourceDebugPanel from "./SourceDebugPanel.vue";
import type { SourceDefinition, SourceProbe } from "../../types/source";

const props = defineProps<{
  source?: SourceDefinition | null;
  readonly?: boolean;
  running?: boolean;
}>();

type EditableSourceDefinition = SourceDefinition;

const emit = defineEmits<{
  close: [];
  save: [source: EditableSourceDefinition];
  edit: [];
  debug: [];
  delete: [];
}>();

const dialog = ref<HTMLDialogElement>();
const transformImportInput = ref<HTMLInputElement | null>(null);
const error = ref("");
const debugKeyword = ref("三体");
const debugReport = ref<SourceProbe>();
const debugRunning = ref(false);
const debugError = ref("");
const promptCopyState = ref<"idle" | "copied" | "failed">("idle");

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createBlankSource(): EditableSourceDefinition {
  return {
    id: "",
    name: "",
    url: "",
    description: "",
    method: "GET",
    format: "json",
    priority: 0,
    transform: "",
  };
}

function cloneSource(source: SourceDefinition): EditableSourceDefinition {
  const cloned = cloneJson(source) as EditableSourceDefinition;
  // 编辑时只展示数据库中已保存的配置，不从任何内置来源回填请求或解析脚本。
  return cloned;
}

const form = reactive<EditableSourceDefinition>(
  props.source ? cloneSource(props.source) : createBlankSource(),
);

interface RequestField {
  id: number;
  key: string;
  value: string;
}

type RequestTab = "query" | "body" | "headers";

const nextRequestFieldId = ref(1);
const requestTab = ref<RequestTab>("query");
const queryFields = ref<RequestField[]>([]);
const bodyFields = ref<RequestField[]>([]);
const headerFields = ref<RequestField[]>([]);

function requestFieldValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value ?? "");
}

function requestFieldsFrom(value: unknown): RequestField[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).map(([key, fieldValue]) => ({
    id: nextRequestFieldId.value++,
    key,
    value: requestFieldValue(fieldValue),
  }));
}

function resetRequestFields(source: SourceDefinition | null | undefined): void {
  queryFields.value = requestFieldsFrom(source?.request?.query);
  bodyFields.value = requestFieldsFrom(source?.request?.body);
  headerFields.value = requestFieldsFrom(source?.request?.headers);
}

resetRequestFields(form);

function addRequestField(fields: RequestField[]): void {
  fields.push({ id: nextRequestFieldId.value++, key: "", value: "" });
}

function removeRequestField(fields: RequestField[], id: number): void {
  const index = fields.findIndex((field) => field.id === id);
  if (index >= 0) fields.splice(index, 1);
}

function requestFieldValueParsed(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function requestFieldsToObject(fields: RequestField[], label: string, parseValues: boolean): Record<string, unknown> | undefined {
  const output: Record<string, unknown> = {};
  for (const field of fields) {
    const key = field.key.trim();
    if (!key) throw new Error(`${label} 字段名不能为空。`);
    if (Object.prototype.hasOwnProperty.call(output, key)) throw new Error(`${label} 字段名不能重复：${key}`);
    output[key] = parseValues ? requestFieldValueParsed(field.value) : field.value;
  }
  return fields.length ? output : undefined;
}

const debugDraft = computed<{ source: EditableSourceDefinition; error: string }>(() => {
  const draft = cloneJson(form);
  try {
    if (!draft.url.trim()) throw new Error("请先填写请求地址。");
    const query = requestFieldsToObject(queryFields.value, "Query", true);
    const body = requestFieldsToObject(bodyFields.value, "Body", true);
    const headers = requestFieldsToObject(headerFields.value, "Headers", false) as Record<string, string> | undefined;
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
    debugReport.value = await $fetch<SourceProbe>("/api/sources/probe", {
      method: "POST",
      body: { sourceId: props.source!.id, kw: debugKeyword.value.trim(), source: debugDraft.value.source },
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

function syncEditor(source?: SourceDefinition | null) {
  const next = source ? cloneSource(source) : createBlankSource();
  for (const key of Object.keys(form) as Array<keyof EditableSourceDefinition>) {
    if (!(key in next)) delete form[key];
  }
  Object.assign(form, next);
  resetRequestFields(form);
  error.value = "";
  debugError.value = "";
  debugReport.value = undefined;
}

async function loadGlobalTransformForNewSource() {
  if (props.source || form.transform.trim()) return;
  try {
    const response = await $fetch<{ data?: { transform?: string } }>("/api/settings/source-template", {
      retry: 0,
    });
    const transform = String(response.data?.transform || "").trim();
    // Do not overwrite text if the user starts editing while the template loads.
    if (!props.source && !form.transform.trim() && transform) form.transform = transform;
  } catch {
    // Keep the editor usable; validation will explain that a transform is required
    // if the global template cannot be loaded.
  }
}

watch(() => props.source, syncEditor);

onMounted(() => {
  dialog.value?.showModal();
  void loadGlobalTransformForNewSource();
});

function openTransformImport() {
  transformImportInput.value?.click();
}

function promptJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

function requestFieldsPreview(fields: RequestField[], parseValues: boolean): Record<string, unknown> {
  return Object.fromEntries(
    fields
      .filter((field) => field.key.trim())
      .map((field) => [field.key.trim(), parseValues ? requestFieldValueParsed(field.value) : field.value]),
  );
}

function buildTransformPrompt(): string {
  const request = {
    query: requestFieldsPreview(queryFields.value, true),
    body: requestFieldsPreview(bodyFields.value, true),
    headers: requestFieldsPreview(headerFields.value, false),
    ...(form.request?.bodyType ? { bodyType: form.request.bodyType } : {}),
    ...(form.request?.redirect ? { redirect: form.request.redirect } : {}),
    ...(form.request?.allowedDomains ? { allowedDomains: form.request.allowedDomains } : {}),
    ...(form.request?.maxResponseBytes !== undefined
      ? { maxResponseBytes: form.request.maxResponseBytes }
      : {}),
    ...(form.request?.maxRequestBodyBytes !== undefined
      ? { maxRequestBodyBytes: form.request.maxRequestBodyBytes }
      : {}),
  };

  return `请帮我为下面这个资源来源编写 transform(payload, $, context) 函数。

## 来源请求配置
- 请求地址：${form.url.trim() || "（未填写）"}
- 请求方式：${form.method}
- 返回格式：${form.format.toUpperCase()}（${form.format === "json" ? "payload 是已解析的 JSON 对象或数组" : "payload 是原始 HTML 字符串"}）
- 请求参数：
${promptJson(request)}

## transform 函数说明
函数签名必须是：
function transform(payload, $, context) {
  // 返回标准结果数组
}

- payload：接口响应内容。JSON 返回格式下已经解析为 JavaScript 对象/数组；HTML 返回格式下是原始 HTML 字符串。
- $：HTML 查询工具（Cheerio API），只有返回格式为 HTML 时可用；解析 JSON 时不要依赖它。
- context：当前解析上下文对象，常用字段包括 context.keyword（当前搜索词）、context.source（来源标识）、context.url（请求地址）、context.rawBody（原始响应文本）和 context.format（json/html）。
- context.makeLink(url, password)：把 URL 转成标准链接对象，自动推断网盘类型；无效 URL 返回 null。context.inferDriveType(url) 可单独获取网盘类型。不要在每个来源里重复维护网盘映射表。
- 函数必须是同步函数，不要发起网络请求；即使没有匹配结果也要返回 []。
- 返回值必须是标准结果 JSON 数组。每个结果至少包含 id、name、description、datetime、links，其中 links 至少包含一个 { url }；可选返回 images 数组保存图片/封面 URL（没有图片时省略）；cloud_types 和 links.type 不需要填写，服务端会根据 URL 自动推断；没有有效资源链接的结果不要返回。
- 如果原始数据包含 poster、cover、image、img、thumbnail、vod_pic 等资源图片字段，请映射到 images 数组；HTML 中也可以从资源区域的 img[src]、data-src 或 background-image 提取图片，但不要把头像、用户头像或 avatar 字段写入 images。
- 请根据当前接口的实际响应结构提取标题、描述、时间和资源链接，并尽量使用 context.keyword 过滤无关结果。

## 输出要求
请只输出可直接粘贴到编辑器的纯 JavaScript 函数代码，不要 Markdown 代码围栏，不要解释文字，不要修改请求配置。请同时兼容字段缺失、空数组和异常响应，避免抛出不必要的错误。

注意：上面的请求参数可能包含密钥或 Cookie，交给第三方 AI 前请先确认并脱敏。`;
}

async function copyTransformPrompt() {
  const prompt = buildTransformPrompt();
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(prompt);
      copied = true;
    }
  } catch {
    copied = false;
  }

  if (!copied) {
    const textarea = document.createElement("textarea");
    textarea.value = prompt;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    textarea.remove();
  }

  promptCopyState.value = copied ? "copied" : "failed";
  if (!copied) {
    error.value = "自动复制失败，请检查浏览器剪贴板权限后重试。";
    return;
  }
  error.value = "";
  window.setTimeout(() => {
    if (promptCopyState.value === "copied") promptCopyState.value = "idle";
  }, 1800);
}

function exportTransform() {
  const blob = new Blob([form.transform || ""], {
    type: "text/javascript;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${form.id || "source-transform"}.js`;
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

  const priority = Number(form.priority ?? 0);
  if (!Number.isInteger(priority) || priority < 0 || priority > 999) {
    error.value = "优先级请输入 0-999 的整数。";
    return;
  }
  form.priority = priority;

  try {
    const query = requestFieldsToObject(queryFields.value, "Query", true);
    const body = requestFieldsToObject(bodyFields.value, "Body", true);
    const headers = requestFieldsToObject(headerFields.value, "Headers", false) as Record<string, string> | undefined;
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

.editor-field-hint {
  display: block;
  margin-top: 5px;
  color: #7b899b;
  font-size: 10px;
  font-weight: 400;
  line-height: 1.4;
}

.editor-primary-grid {
  grid-template-columns: minmax(220px, 0.8fr) minmax(320px, 1.2fr);
}

.editor-connection-grid {
  /* Keep method/format wide; priority is a compact numeric control. */
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(150px, 0.42fr);
  align-items: start;
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
  display: block;
}

.request-config-grid label {
  margin-bottom: 0;
}

.request-tabs {
  display: flex;
  gap: 4px;
  padding: 4px;
  border: 1px solid #e1e8f1;
  border-radius: 9px;
  background: #eef3f9;
}

.request-tabs button {
  flex: 1;
  min-height: 32px;
  padding: 6px 12px;
  border: 0;
  border-radius: 6px;
  color: #64748b;
  background: transparent;
  font-size: 12px;
  cursor: pointer;
}

.request-tabs button:hover {
  color: #334155;
}

.request-tabs button.active {
  color: #1d4ed8;
  background: #fff;
  box-shadow: 0 1px 3px rgba(30, 64, 110, 0.12);
  font-weight: 700;
}

.request-tab-panel {
  min-width: 0;
}

.request-fields {
  display: grid;
  gap: 8px;
  width: 100%;
  margin-top: 6px;
}

.request-fields-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: #64748b;
  font-size: 11px;
}

.request-fields-empty {
  padding: 13px 10px;
  border: 1px dashed #cbd5e1;
  border-radius: 8px;
  color: #94a3b8;
  background: #f8fafc;
  font-size: 11px;
  text-align: center;
}

.request-field-row {
  display: grid;
  grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr) auto;
  align-items: start;
  gap: 6px;
}

.request-field-row input,
.request-field-row textarea {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  min-height: 34px;
  padding: 8px 9px;
  border: 1px solid #d8e0eb;
  border-radius: 7px;
  background: #fff;
  color: #263247;
  font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
  resize: vertical;
}

.request-field-row input:focus,
.request-field-row textarea:focus {
  border-color: #7899d4;
  outline: 2px solid rgba(79, 124, 205, 0.16);
}

.request-field-remove {
  min-height: 34px;
  padding: 0 7px;
  border: 1px solid #e2c5c5;
  border-radius: 7px;
  color: #b4534b;
  background: #fff8f7;
  font-size: 11px;
  cursor: pointer;
}

.request-field-remove:disabled {
  cursor: not-allowed;
  opacity: 0.5;
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

  .editor-primary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .request-config-grid {
    display: block;
  }

  .editor-connection-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
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
