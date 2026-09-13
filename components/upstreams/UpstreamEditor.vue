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
        <div>
          <span class="editor-kicker">UPSTREAM</span>
          <h2 id="editor-title">
            {{ readonly ? "上游详情" : source ? "编辑上游" : "新增上游" }}
          </h2>
        </div>
        <button
          type="button"
          class="icon-button"
          aria-label="关闭配置"
          @click="dialog?.close()"
        >
          <ConsoleIcon name="close" />
        </button>
      </header>

      <label>
        上游名称 <span class="required-marker">*</span>
        <input
          v-model="form.name"
          required
          maxlength="40"
          placeholder="例如：我的资源接口"
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
          placeholder="描述这个接口的用途或资源类型"
        />
      </label>

      <div class="editor-grid source-kind-grid">
        <label>
          来源类型
          <select v-model="form.sourceKind" :disabled="readonly">
            <option value="http">HTTP 上游</option>
            <option value="telegram">TG 频道</option>
          </select>
        </label>
        <label v-if="form.sourceKind === 'telegram'">
          TG 频道
          <input v-model="form.channel" placeholder="@channel_username" pattern="@?[A-Za-z0-9_]{5,64}" :readonly="readonly" />
        </label>
      </div>

      <label>
        接口地址 <span class="required-marker">*</span>
        <input
          v-model="form.url"
          required
          type="url"
          placeholder="https://api.example.com/search"
          maxlength="500"
          :readonly="readonly"
        />
      </label>

      <div class="editor-grid">
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

      <details class="editor-advanced" open>
        <summary>请求配置</summary>
        <div class="editor-grid reliability-grid">
          <label>
            备用 URL
            <textarea v-model="fallbackUrlsText" class="code-input" rows="3" spellcheck="false" placeholder="每行一个 HTTPS 地址；主地址失败后按顺序尝试" :readonly="readonly" />
          </label>
          <div class="editor-grid retry-grid">
            <label>
              单地址重试
              <input v-model.number="retryMaxRetries" type="number" min="0" max="3" :readonly="readonly" />
            </label>
            <label>
              重试间隔 (ms)
              <input v-model.number="retryDelayMs" type="number" min="0" max="5000" step="100" :readonly="readonly" />
            </label>
          </div>
        </div>
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

      <details class="editor-meta">
        <summary>标签与分类</summary>
        <div class="editor-grid">
          <label>管理标签 <input v-model="tagsText" placeholder="例如：稳定, 免费, 推荐" :readonly="readonly" /></label>
          <label>网盘类型 <input v-model="form.driveType" placeholder="例如：阿里云盘 / 夸克 / 磁力" :readonly="readonly" /></label>
          <label>资源类型 <input v-model="resourceTypesText" placeholder="例如：电影, 动漫, 小说, 音乐, 资料" :readonly="readonly" /></label>
        </div>
      </details>

      <details class="editor-function" open>
        <summary>解析函数</summary>
        <div class="function-field">
          <p id="transform-help" class="editor-help transform-help">
            <code>payload</code> 是接口响应内容；<code>$</code> 是 HTML 查询工具；<code>context</code> 提供 <code>keyword</code>、分页等请求上下文。
            函数必须返回标准结果 JSON 数组，例如 <code>[{ title, links: [{ url }] }]</code>。
          </p>
          <div class="function-toolbar">
            <span class="function-label">transform(payload, $, context)</span>
            <div class="function-file-actions" aria-label="解析函数文件操作">
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

      <slot name="readonly-extra" />

      <p v-if="error" class="form-error" role="alert">{{ error }}</p>

      <footer>
        <template v-if="readonly">
          <button type="button" class="button secondary" @click="dialog?.close()">
            关闭
          </button>
          <button type="button" class="button secondary" @click="$emit('edit')">
            <ConsoleIcon name="edit" :size="15" />修改配置
          </button>
          <button type="button" class="button secondary" :disabled="running" @click="$emit('debug')">
            <ConsoleIcon name="play" :size="15" />打开调试
          </button>
          <button type="button" class="button danger-button" @click="$emit('delete')">
            <ConsoleIcon name="trash" :size="15" />删除上游
          </button>
        </template>
        <template v-else>
          <button type="button" class="button secondary" @click="dialog?.close()">
            取消
          </button>
          <button type="submit" class="button primary">
            <ConsoleIcon name="check" />
            {{ source ? "保存配置" : "创建上游" }}
          </button>
        </template>
      </footer>
    </form>
  </dialog>
</template>

<script setup lang="ts">
import ConsoleIcon from "./ConsoleIcon.vue";
import {
  BUILTIN_UPSTREAMS,
  getDefaultUpstreamTransform,
  type UpstreamDefinition,
} from "../../config/upstreams";

const props = defineProps<{
  source?: UpstreamDefinition | null;
  readonly?: boolean;
  running?: boolean;
}>();

type EditableUpstreamDefinition = UpstreamDefinition & { transform?: string };

const emit = defineEmits<{
  close: [];
  save: [source: EditableUpstreamDefinition];
  edit: [];
  debug: [];
  delete: [];
}>();

const EMPTY_TRANSFORM = "function transform(payload, $, context) {\n  return [];\n}";
const dialog = ref<HTMLDialogElement>();
const transformImportInput = ref<HTMLInputElement | null>(null);
const error = ref("");

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createBlankSource(): EditableUpstreamDefinition {
  return {
    id: "",
    sourceKind: "http",
    name: "",
    url: "",
    description: "",
    method: "GET",
    format: "json",
    plugin: "custom",
    adapter: "",
    color: "#697fbd",
    initials: "C",
    mapping: {
      items: "",
      title: "",
      url: "",
      password: "",
      type: "",
    },
    builtin: true,
    transform: EMPTY_TRANSFORM,
  };
}

function cloneSource(source: UpstreamDefinition): EditableUpstreamDefinition {
  const cloned = cloneJson(source) as EditableUpstreamDefinition;
  const configuredDefaults = BUILTIN_UPSTREAMS.find((item) => item.id === cloned.id);
  if (!cloned.request && configuredDefaults?.request) {
    cloned.request = cloneJson(configuredDefaults.request);
  }
  const persistedTransform = cloned.transform?.trim();
  if (!persistedTransform) {
    // Older custom rows may still rely on their legacy core fallback. Only
    // hydrate the shipped defaults here; do not overwrite those rows with an
    // empty function just because they have no transform field yet.
    const defaultTransform = getDefaultUpstreamTransform(cloned.id);
    if (defaultTransform) cloned.transform = defaultTransform;
  }
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
const fallbackUrlsText = ref((form.fallbackUrls || []).join("\n"));
const tagsText = ref((form.tags || []).join(", "));
const resourceTypesText = ref((form.resourceTypes || []).join(", "));
const retryMaxRetries = ref(form.retry?.maxRetries ?? form.request?.retry?.maxRetries ?? 1);
const retryDelayMs = ref(form.retry?.delayMs ?? form.request?.retry?.delayMs ?? 300);

function syncEditor(source?: UpstreamDefinition | null) {
  const next = source ? cloneSource(source) : createBlankSource();
  for (const key of Object.keys(form) as Array<keyof EditableUpstreamDefinition>) {
    if (!(key in next)) delete form[key];
  }
  Object.assign(form, next);
  requestQueryText.value = stringifyRequestValue(form.request?.query);
  requestBodyText.value = stringifyRequestValue(form.request?.body);
  requestHeadersText.value = stringifyRequestValue(form.request?.headers);
  fallbackUrlsText.value = (form.fallbackUrls || []).join("\n");
  tagsText.value = (form.tags || []).join(", ");
  resourceTypesText.value = (form.resourceTypes || []).join(", ");
  retryMaxRetries.value = form.retry?.maxRetries ?? form.request?.retry?.maxRetries ?? 1;
  retryDelayMs.value = form.retry?.delayMs ?? form.request?.retry?.delayMs ?? 300;
  error.value = "";
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
    error.value = "请输入不含账户凭据的 HTTPS 地址。";
    return;
  }

  if (!form.name.trim()) {
    error.value = "请填写上游名称。";
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
    const splitList = (text: string) => [...new Set(text.split(/[,\n]/).map((item) => item.trim()).filter(Boolean))];
    const fallbackUrls = splitList(fallbackUrlsText.value);
    form.fallbackUrls = fallbackUrls;
    form.tags = splitList(tagsText.value);
    form.resourceTypes = splitList(resourceTypesText.value);
    const maxRetries = Math.min(3, Math.max(0, Number(retryMaxRetries.value) || 0));
    const delayMs = Math.min(5000, Math.max(0, Number(retryDelayMs.value) || 0));
    form.retry = { maxRetries, delayMs };
    form.request = {
      ...(form.request || {}),
      fallbackUrls,
      retry: { maxRetries, delayMs },
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
  form.initials = form.name.charAt(0).toUpperCase();
  emit("save", JSON.parse(JSON.stringify(form)));
  dialog.value?.close();
}
</script>

<style scoped>
.source-dialog {
  overflow: hidden;
}

.editor-form {
  box-sizing: border-box;
  max-height: min(88vh, 900px);
  overflow-y: auto;
  padding: 27px;
}

.editor-header {
  position: sticky;
  top: -27px;
  z-index: 2;
  margin: -27px -27px 22px;
  padding: 27px 27px 17px;
  background: #fff;
}

.editor-form label {
  position: relative;
}

.source-kind-grid {
  align-items: end;
}

.reliability-grid {
  align-items: start;
  margin-bottom: 14px;
}

.reliability-grid > label {
  margin-bottom: 0;
}

.retry-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: end;
}

.editor-meta,
.editor-advanced,
.editor-function {
  border: 1px solid #dbe7f5;
  border-radius: 10px;
  background: #f8fbff;
}

.editor-meta {
  margin-top: 14px;
  padding: 13px 14px 14px;
  border: 1px solid #dbe7f5;
  border-radius: 10px;
  background: #f8fbff;
}

.editor-advanced {
  margin-top: 19px;
  padding: 13px 14px 14px;
}

.editor-meta summary,
.editor-advanced summary,
.editor-function summary {
  color: #334155;
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
  list-style-position: inside;
}

.editor-meta[open] summary,
.editor-advanced[open] summary,
.editor-function[open] summary {
  margin-bottom: 13px;
}

.request-config-grid {
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

@media (max-width: 600px) {
  .editor-form {
    padding: 22px;
  }

  .editor-header {
    top: -22px;
    margin: -22px -22px 18px;
    padding: 22px 22px 14px;
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
