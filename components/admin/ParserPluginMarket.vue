<template>
  <section class="sources-panel parser-market" aria-label="解析插件市场">
    <header class="market-header">
      <div class="market-title">
        <span class="section-kicker">PLUGIN REGISTRY</span>
        <div class="market-title-line">
          <h2>解析插件市场</h2>
          <span class="market-live"><span class="market-live-dot"></span>SQLite 实时配置</span>
        </div>
        <p>统一管理请求配置与解析函数。</p>
      </div>

    </header>

    <div class="market-stats" aria-label="插件统计">
      <div class="market-stat">
        <span class="market-stat-label">全部来源</span>
        <strong>{{ marketItems.length }}</strong>
      </div>
      <div class="market-stat">
        <span class="market-stat-label">已发布</span>
        <strong>{{ publishedCount }}</strong>
      </div>
      <div class="market-stat bound-stat">
        <span class="market-stat-label">已绑定</span>
        <strong>{{ boundPluginCount }}</strong>
      </div>
    </div>

    <form class="market-query-panel" aria-label="插件查询条件" @submit.prevent="applyQuery">
      <div class="query-panel-heading">
        <div>
          <span class="section-kicker">FILTERS</span>
          <strong>筛选插件</strong>
        </div>
        <span class="query-result">当前显示 {{ filteredItems.length }} / {{ marketItems.length }}</span>
      </div>
      <div class="query-fields">
        <label class="query-keyword">
          <span>关键词</span>
          <span class="input-with-icon">
            <ConsoleIcon name="search" :size="16" />
            <input v-model="queryForm.keyword" type="search" placeholder="搜索名称、ID 或说明" aria-label="搜索插件名称、ID 或说明" />
          </span>
        </label>
        <label>
          <span>状态</span>
          <select v-model="queryForm.status" aria-label="按状态筛选">
            <option value="">全部状态</option>
            <option value="draft">草稿</option>
            <option value="published">已发布</option>
            <option value="disabled">已停用</option>
            <option value="archived">已删除</option>
          </select>
        </label>
        <label>
          <span>格式</span>
          <select v-model="queryForm.format" aria-label="按格式筛选">
            <option value="">全部格式</option>
            <option value="html">HTML</option>
            <option value="json">JSON</option>
            <option value="text">纯文本 / Markdown</option>
            <option value="auto">自动</option>
          </select>
        </label>
        <label>
          <span>目标</span>
          <select v-model="queryForm.target" aria-label="按目标筛选">
            <option value="">全部目标</option>
            <option value="upstream">上游</option>
            <option value="telegram">TG 频道</option>
            <option value="both">上游 + TG</option>
          </select>
        </label>
      </div>
      <div class="query-footer">
        <div class="market-toolbar query-toolbar-actions">
          <button class="button secondary" type="button" @click="openImport">
            <ConsoleIcon name="upload" :size="15" />导入
          </button>
          <button class="button secondary" type="button" @click="exportPlugins">
            <ConsoleIcon name="download" :size="15" />导出
          </button>
          <button class="button secondary icon-text-button" type="button" :disabled="loading" @click="load">
            <ConsoleIcon name="refresh" :size="15" />{{ loading ? "刷新中…" : "刷新" }}
          </button>
          <input ref="importInput" class="market-file" type="file" accept="application/json,.json,.js,.mjs,text/javascript" @change="importPlugins" />
        </div>
        <div class="query-buttons">
          <button class="button primary small" type="submit">查询</button>
          <button class="button secondary small" type="button" @click="clearFilters">重置</button>
        </div>
      </div>
    </form>

    <div class="market-actions" aria-label="插件批量操作">
      <div class="selection-summary">
        <span class="action-label">列表操作</span>
        <span class="selection-count">{{ selectedIds.length ? `已选 ${selectedIds.length} 个` : "未选择插件" }}</span>
        <span v-if="boundSelected.length" class="selection-warning">{{ boundSelected.length }} 个已绑定，不能删除</span>
      </div>
      <div class="market-action-buttons">
        <button class="button primary" type="button" @click="openCreate">
          <ConsoleIcon name="plus" :size="16" />新增解析器
        </button>
        <button
          class="button danger-button"
          type="button"
          :disabled="bulkRunning || !deletableSelected.length"
          :title="boundSelected.length ? '已绑定插件不能删除，请先解除绑定' : '删除后会移入垃圾箱，可在垃圾箱中恢复'"
          @click="deleteSelected"
        >
          <ConsoleIcon name="trash" :size="15" />{{ bulkRunning ? "删除中…" : "删除" }}
        </button>
        <button
          class="button secondary"
          type="button"
          :disabled="selectedPlugins.length !== 1 || bulkRunning"
          @click="editSelected"
        >
          <ConsoleIcon name="edit" :size="15" />编辑
        </button>
      </div>
    </div>

    <div class="plugin-list-panel">
      <div class="list-heading">
        <div>
          <span class="section-kicker">PLUGIN LIST</span>
          <h3>来源列表</h3>
        </div>
        <span v-if="selectedIds.length" class="list-selection-note">已选 {{ selectedIds.length }} 个</span>
      </div>

      <div v-if="loading" class="archive-empty plugin-empty">
        <span class="spinner"></span>
        <span>正在加载插件列表…</span>
      </div>
      <div v-else-if="!filteredItems.length" class="archive-empty plugin-empty">
        <ConsoleIcon name="search" :size="28" />
        <strong>{{ marketItems.length ? "没有匹配的来源" : "还没有配置来源" }}</strong>
        <span>{{ marketItems.length ? "换一个关键词，或调整筛选条件。" : "先在上游接口中配置来源。" }}</span>
        <button v-if="hasFilters" class="button secondary small" type="button" @click="clearFilters">清空查询条件</button>
      </div>

      <div v-else class="table-scroll plugin-table-scroll">
        <table class="plugin-table">
          <thead>
            <tr>
              <th class="check-column">
                <input
                  type="checkbox"
                  :checked="allVisibleSelected"
                  :indeterminate="someVisibleSelected && !allVisibleSelected"
                  aria-label="选择当前显示的插件"
                  @change="toggleAllVisible"
                />
              </th>
              <th>插件 / 来源</th>
              <th class="binding-column">已绑定对象</th>
              <th>请求配置</th>
              <th>transform</th>
              <th>状态</th>
              <th>最近更新</th>
              <th class="action-column">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in filteredItems" :key="item.key" :class="{ 'selected-row': item.kind === 'parser' && selectedIds.includes(item.id), 'configured-row': item.kind === 'configured-upstream' }">
              <td class="check-column">
                <input
                  v-if="item.kind === 'parser'"
                  type="checkbox"
                  :checked="selectedIds.includes(item.id)"
                  :aria-label="`选择 ${item.manifest.name}`"
                  @change="toggleSelection(item.id)"
                />
                <span v-else class="source-type-mark" aria-label="配置插件">↳</span>
              </td>
              <template v-if="item.kind === 'configured-upstream'">
                <td>
                  <div class="plugin-identity">
                    <strong>{{ item.source.name }} <span class="configured-tag">上游插件</span></strong>
                    <code>{{ item.source.id }}</code>
                    <span class="plugin-description" :title="item.source.url">{{ item.source.description || item.source.url }}</span>
                  </div>
                </td>
                <td class="binding-cell">
                  <div class="plugin-binding-tags" aria-label="插件绑定">
                    <span class="binding-tag upstream"><span class="binding-tag-kind">上游</span>{{ item.source.id }}</span>
                  </div>
                </td>
                <td>
                  <div class="request-cell">
                    <strong>{{ item.source.method }} · {{ formatLabel(item.source.format) }}</strong>
                    <code :title="item.source.url">{{ compactUrl(item.source.url) }}</code>
                  </div>
                </td>
                <td>
                  <div class="transform-cell">
                    <code>transform(payload, $, context)</code>
                    <span>{{ item.source.transform ? '可编辑函数' : '兼容旧函数' }}</span>
                  </div>
                </td>
                <td><span class="status-badge" :class="item.status">{{ item.status === 'disabled' ? '已停用' : '已启用' }}</span></td>
                <td><span class="updated-time">实时</span></td>
                <td class="action-column">
                  <div class="plugin-actions">
                    <button class="button secondary small" type="button" @click="emit('edit-upstream', item.source.id)">
                      <ConsoleIcon name="edit" :size="14" />编辑函数
                    </button>
                  </div>
                </td>
              </template>
              <template v-else-if="item.kind === 'configured-telegram'">
                <td>
                  <div class="plugin-identity">
                    <strong>@{{ item.channel }} <span class="configured-tag">TG 插件</span></strong>
                    <code>{{ item.id }}</code>
                    <span class="plugin-description">Telegram 频道请求与解析函数</span>
                  </div>
                </td>
                <td class="binding-cell">
                  <div class="plugin-binding-tags" aria-label="插件绑定">
                    <span class="binding-tag telegram"><span class="binding-tag-kind">TG</span>@{{ item.channel }}</span>
                    <span v-if="item.parserId" class="binding-tag upstream"><span class="binding-tag-kind">函数</span>{{ item.parserId }}</span>
                  </div>
                </td>
                <td>
                  <div class="request-cell">
                    <strong>GET · HTML</strong>
                    <code>{{ item.requestSummary }}</code>
                  </div>
                </td>
                <td>
                  <div class="transform-cell">
                    <code>transform(payload, $, context)</code>
                    <span>{{ item.parserId ? `已绑定 ${item.parserId}` : '使用配置默认函数' }}</span>
                  </div>
                </td>
                <td><span class="status-badge published">已启用</span></td>
                <td><span class="updated-time">实时</span></td>
                <td class="action-column">
                  <div class="plugin-actions">
                    <button class="button secondary small" type="button" @click="emit('edit-telegram', item.channel)">
                      <ConsoleIcon name="edit" :size="14" />编辑函数
                    </button>
                  </div>
                </td>
              </template>
              <template v-else>
                <td>
                  <div class="plugin-identity">
                    <strong>{{ item.manifest.name }}</strong>
                    <code>{{ item.id }}</code>
                    <span v-if="item.manifest.description" class="plugin-description">{{ item.manifest.description }}</span>
                  </div>
                </td>
                <td class="binding-cell">
                  <div v-if="bindingsFor(item.id).length" class="plugin-binding-tags" aria-label="已绑定对象">
                    <span v-for="binding in bindingsFor(item.id)" :key="`${binding.scope}:${binding.id}`" class="binding-tag" :class="binding.scope">
                      <span class="binding-tag-kind">{{ binding.scope === 'telegram' ? 'TG' : '上游' }}</span>
                      {{ binding.scope === 'telegram' ? `@${binding.id}` : binding.id }}
                    </span>
                  </div>
                  <span v-else class="no-binding">未绑定</span>
                </td>
                <td>
                  <div class="version-cell">
                    <strong>v{{ item.manifest.version }}</strong>
                    <span v-if="item.publishedVersion && item.publishedVersion !== item.manifest.version">线上 v{{ item.publishedVersion }}</span>
                  </div>
                </td>
                <td>
                  <div class="format-cell">
                    <span class="format-tag">{{ formatLabel(item.manifest.format) }}</span>
                    <span>{{ targetLabel(item.manifest.target) }}</span>
                  </div>
                </td>
                <td>
                  <span class="status-badge" :class="item.status">{{ statusLabel(item.status) }}</span>
                  <span v-if="item.lastTestError" class="test-warning" :title="item.lastTestError">样本测试失败</span>
                  <span v-else-if="item.lastTestedVersion" class="test-success">已测试</span>
                </td>
                <td><time class="updated-time" :datetime="item.updatedAt">{{ formatDate(item.updatedAt) }}</time></td>
                <td class="action-column">
                  <div class="plugin-actions">
                    <button class="button secondary small" type="button" :disabled="!!busyAction" @click="edit(item)">
                      <ConsoleIcon name="edit" :size="14" />编辑
                    </button>
                    <button v-if="item.status === 'disabled'" class="button primary small" type="button" :disabled="!!busyAction" @click="action(item, 'enable')">启用</button>
                    <button v-else-if="item.status === 'archived'" class="button primary small" type="button" :disabled="!!busyAction" @click="action(item, 'restore')">恢复</button>
                    <button v-else-if="item.status !== 'published' || item.publishedVersion !== item.manifest.version" class="button primary small" type="button" :disabled="!!busyAction" @click="action(item, 'publish')">{{ item.status === 'published' ? '发布新版本' : '发布' }}</button>
                    <button v-else class="button secondary small" type="button" :disabled="!!busyAction" @click="action(item, 'disable')">停用</button>
                    <button v-if="item.status !== 'archived'" class="button danger-button small" type="button" :disabled="!!busyAction || isBound(item.id)" :title="isBound(item.id) ? '已绑定到上游或 TG 频道，解除绑定后才能删除' : '删除并移入垃圾箱'" @click="action(item, 'archive')">删除</button>
                  </div>
                </td>
              </template>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <p v-if="error" class="form-error market-error" role="alert">{{ error }}</p>

    <dialog ref="editorDialog" class="plugin-editor-dialog" aria-labelledby="plugin-editor-title" @close="onEditorClose" @click="onEditorBackdrop">
      <form class="plugin-editor-form" @submit.prevent="save">
        <header class="plugin-editor-header">
          <div>
            <span class="editor-kicker">PARSER PLUGIN</span>
            <h2 id="plugin-editor-title">{{ editing ? "编辑解析插件" : "新增解析插件" }}</h2>
            <p>{{ editing ? "修改当前草稿并保存为新的可发布版本。" : "创建一个解析器草稿，保存后再进行样本测试与发布。" }}</p>
          </div>
          <button class="icon-button" type="button" aria-label="关闭插件编辑" @click="closeEditor">
            <ConsoleIcon name="close" :size="18" />
          </button>
        </header>

        <div class="plugin-editor-body">
          <div class="form-grid">
            <label>
              ID
              <input v-model="draft.manifest.id" :disabled="!!editing" required placeholder="my-parser" />
            </label>
            <label>
              名称
              <input v-model="draft.manifest.name" required placeholder="我的解析器" />
            </label>
            <label>
              版本
              <input v-model="draft.manifest.version" required placeholder="1.0.0" />
            </label>
            <label>
              格式
              <select v-model="draft.manifest.format">
                <option value="html">HTML + Cheerio</option>
                <option value="json">JSON</option>
                <option value="text">纯文本 / Markdown</option>
                <option value="auto">自动（按响应格式）</option>
              </select>
            </label>
            <label>
              目标
              <select v-model="draft.manifest.target">
                <option value="upstream">上游</option>
                <option value="telegram">TG 频道</option>
                <option value="both">上游 + TG</option>
              </select>
            </label>
            <label>
              超时(ms)
              <input v-model.number="draft.manifest.timeoutMs" type="number" min="100" max="5000" />
            </label>
          </div>
          <label>
            说明
            <input v-model="draft.manifest.description" placeholder="解析器用途" />
          </label>
          <label>
            <span class="function-label-line"><span>transform(payload, $, context)</span><span class="function-file-actions"><button class="text-button" type="button" @click="openTransformImport">导入 JS</button><button class="text-button" type="button" :disabled="!draft.code.trim()" @click="exportTransform(draft.manifest.id || 'parser-plugin')">导出 JS</button></span></span>
            <textarea v-model="draft.code" rows="15" spellcheck="false" required placeholder="function transform(payload, $, context) {
  return [];
}" />
            <input ref="transformImportInput" class="market-file" type="file" accept=".js,.mjs,text/javascript" @change="importTransform" />
          </label>
          <p class="field-hint">HTML 时 payload 是原始 HTML 字符串且 $ 是 Cheerio 实例；JSON 时 payload 是已解析对象；auto 会按 context.format 自动切换。context 包含 channel、keyword、url、rawBody。</p>
          <div class="sample-toolbar">
            <label>
              样本格式
              <select v-model="sampleFormat">
                <option value="html">HTML</option>
                <option value="json">JSON</option>
                <option value="text">纯文本 / Markdown</option>
              </select>
            </label>
            <span class="field-hint">auto 插件必须选择本次样本的实际格式。</span>
          </div>
          <label>
            样本原文（可选，用于发布前测试）
            <textarea v-model="sampleRawBody" rows="5" spellcheck="false" placeholder="粘贴上游 HTML / JSON / Markdown 原文" />
          </label>
          <p v-if="testMessage" class="field-hint test-message">{{ testMessage }}</p>
          <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        </div>

        <footer class="plugin-editor-footer">
          <button class="button secondary" type="button" @click="closeEditor">取消</button>
          <button v-if="editing" class="button secondary" type="button" :disabled="testing || !sampleRawBody.trim()" @click="testCurrent">
            {{ testing ? "测试中…" : "测试样本" }}
          </button>
          <button class="button primary" :disabled="saving" type="submit">
            {{ saving ? "保存中…" : "保存草稿" }}
          </button>
        </footer>
      </form>
    </dialog>
  </section>
</template>

<script setup lang="ts">
import { nextTick } from "vue";
import ConsoleIcon from "../upstreams/ConsoleIcon.vue";
import type {
  ParserInputFormat,
  ParserPluginFormat,
  ParserPluginRecord,
  ParserPluginStatus,
  ParserPluginTarget,
} from "../../server/core/parsers/types";
import type { UpstreamDefinition } from "../../config/upstreams";

type PluginFilter = "" | ParserPluginStatus;
type PluginAction = "enable" | "restore" | "publish" | "disable" | "archive";
type BindingScope = "upstream" | "telegram";
type ParserBinding = { pluginId?: string | null; updatedAt?: string };
type ParserBindings = { upstream: Record<string, ParserBinding>; telegram: Record<string, ParserBinding> };
type BindingTag = { scope: BindingScope; id: string };
type MarketPlugin =
  | (ParserPluginRecord & { kind: "parser"; key: string; source?: never; channel?: never })
  | (ParserPluginRecord & { kind: "configured-upstream"; key: string; source: UpstreamDefinition & { transform?: string }; channel?: never })
  | (ParserPluginRecord & { kind: "configured-telegram"; key: string; source?: never; channel: string; parserId?: string; requestSummary: string });

const emit = defineEmits<{
  "edit-upstream": [id: string];
  "edit-telegram": [channel: string];
}>();

const plugins = ref<ParserPluginRecord[]>([]);
const configuredUpstreams = ref<UpstreamDefinition[]>([]);
const telegramSettings = ref<{ channels: string[] | null; defaultChannels: string[]; effectiveChannels: string[] }>({ channels: null, defaultChannels: [], effectiveChannels: [] });
const tgSourceSettings = ref<{ directTemplate: string; jinaTemplate: string; userAgent: string }>({ directTemplate: "", jinaTemplate: "", userAgent: "" });
const loading = ref(false);
const saving = ref(false);
const bulkRunning = ref(false);
const busyAction = ref("");
const error = ref("");
const editing = ref<string | null>(null);
const bindings = ref<ParserBindings>({ upstream: {}, telegram: {} });
const importInput = ref<HTMLInputElement | null>(null);
const transformImportInput = ref<HTMLInputElement | null>(null);
const editorDialog = ref<HTMLDialogElement | null>(null);
const sampleRawBody = ref("");
const sampleFormat = ref<ParserInputFormat>("html");
const testing = ref(false);
const testMessage = ref("");
const queryForm = reactive({
  keyword: "",
  status: "" as PluginFilter,
  format: "" as ParserPluginFormat | "",
  target: "" as ParserPluginTarget | "",
});
const query = reactive({ ...queryForm });
const selectedIds = ref<string[]>([]);

const empty = () => ({
  manifest: {
    id: "",
    name: "",
    version: "1.0.0",
    description: "",
    format: "auto" as ParserPluginFormat,
    target: "both" as ParserPluginTarget,
    timeoutMs: 1000,
    maxResults: 200,
  },
  code: "function transform(payload, $, context) {\n  return [];\n}",
});
const draft = reactive(empty());

const marketItems = computed<MarketPlugin[]>(() => [
  ...configuredUpstreams.value.map((source): MarketPlugin => ({
    kind: "configured-upstream",
    key: `upstream:${source.id}`,
    id: source.id,
    status: source.enabled === false ? "disabled" : "published",
    manifest: {
      id: source.id,
      name: source.name,
      version: "config",
      description: source.description,
      format: source.format,
      target: "upstream",
      timeoutMs: source.request?.timeoutMs || 1000,
      maxResults: 200,
    },
    code: "",
    versions: [],
    createdAt: "",
    updatedAt: "",
    updatedBy: "system",
    source,
  })),
  ...(telegramSettings.value.effectiveChannels || []).map((channel): MarketPlugin => ({
    kind: "configured-telegram",
    key: `telegram:${channel}`,
    id: `tg:${channel}`,
    channel,
    parserId: bindings.value.telegram[channel]?.pluginId || undefined,
    requestSummary: compactUrl(tgSourceSettings.value.directTemplate.replace("{{channel}}", channel)),
    status: "published",
    manifest: {
      id: `tg:${channel}`,
      name: `@${channel}`,
      version: "config",
      description: "Telegram 频道请求与解析函数",
      format: "html",
      target: "telegram",
      timeoutMs: 12000,
      maxResults: 200,
    },
    code: "",
    versions: [],
    createdAt: "",
    updatedAt: "",
    updatedBy: "system",
  })),
  ...plugins.value.map((plugin): MarketPlugin => ({ kind: "parser", key: `parser:${plugin.id}`, ...plugin })),
]);
const filteredItems = computed(() => {
  const normalizedKeyword = query.keyword.trim().toLowerCase();
  return marketItems.value.filter((plugin) => {
    const source = plugin.source;
    const matchesKeyword = !normalizedKeyword || [
      plugin.id, plugin.manifest.name, plugin.manifest.description,
      source?.url, source?.adapter, source?.plugin, plugin.channel,
    ].some((value) => String(value || "").toLowerCase().includes(normalizedKeyword));
    const target = plugin.source ? "upstream" : plugin.manifest.target;
    return matchesKeyword && (!query.status || plugin.status === query.status) && (!query.format || plugin.manifest.format === query.format) && (!query.target || target === query.target);
  });
});
const publishedCount = computed(() => marketItems.value.filter((item) => item.status === "published").length);
const pluginBindingMap = computed<Record<string, BindingTag[]>>(() => {
  const map: Record<string, BindingTag[]> = {};
  const add = (scope: BindingScope, id: string, binding?: ParserBinding) => {
    const pluginId = String(binding?.pluginId || "").trim().toLowerCase();
    if (!pluginId) return;
    (map[pluginId] ||= []).push({ scope, id });
  };
  for (const [id, binding] of Object.entries(bindings.value.upstream)) add("upstream", id, binding);
  for (const [id, binding] of Object.entries(bindings.value.telegram)) add("telegram", id, binding);
  return map;
});
const selectedPlugins = computed(() => marketItems.value.filter((plugin) => plugin.kind === "parser" && selectedIds.value.includes(plugin.id)));
const boundPluginCount = computed(() => marketItems.value.filter((plugin) => plugin.kind === "parser" && isBound(plugin.id)).length);
const boundSelected = computed(() => selectedPlugins.value.filter((plugin) => isBound(plugin.id)));
const deletableSelected = computed(() => selectedPlugins.value.filter((plugin) => plugin.kind === "parser" && plugin.status !== "archived" && !isBound(plugin.id)));
const selectableVisiblePlugins = computed(() => filteredItems.value.filter((plugin) => plugin.kind === "parser"));
const allVisibleSelected = computed(() => selectableVisiblePlugins.value.length > 0 && selectableVisiblePlugins.value.every((plugin) => selectedIds.value.includes(plugin.id)));
const someVisibleSelected = computed(() => selectableVisiblePlugins.value.some((plugin) => selectedIds.value.includes(plugin.id)));
const hasFilters = computed(() => !!query.keyword.trim() || !!query.status || !!query.format || !!query.target);

function applyQuery() {
  Object.assign(query, queryForm);
  selectedIds.value = [];
}

function resetDraft() {
  const fresh = empty();
  Object.assign(draft.manifest, fresh.manifest);
  draft.code = fresh.code;
  editing.value = null;
  sampleRawBody.value = "";
  sampleFormat.value = "html";
  testMessage.value = "";
  error.value = "";
}

function openCreate() {
  resetDraft();
  showEditor();
}

function edit(plugin: ParserPluginRecord) {
  editing.value = plugin.id;
  Object.assign(draft.manifest, plugin.manifest);
  draft.code = plugin.code;
  sampleRawBody.value = "";
  sampleFormat.value = plugin.manifest.format === "json" ? "json" : plugin.manifest.format === "text" ? "text" : "html";
  testMessage.value = "";
  error.value = "";
  showEditor();
}

function editSelected() {
  const item = selectedPlugins.value[0];
  if (!item || selectedPlugins.value.length !== 1) return;
  edit(item);
}

function showEditor() {
  nextTick(() => {
    if (!editorDialog.value?.open) editorDialog.value?.showModal();
  });
}

function closeEditor() {
  editorDialog.value?.close();
}

function onEditorClose() {
  resetDraft();
}

function onEditorBackdrop(event: MouseEvent) {
  const element = editorDialog.value;
  if (!element || event.target !== element) return;
  const rect = element.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) element.close();
}

function clearFilters() {
  Object.assign(queryForm, { keyword: "", status: "", format: "", target: "" });
  applyQuery();
}

function toggleSelection(id: string) {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((selectedId) => selectedId !== id)
    : [...selectedIds.value, id];
}

function toggleAllVisible(event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  const visibleIds = selectableVisiblePlugins.value.map((plugin) => plugin.id);
  selectedIds.value = checked
    ? [...new Set([...selectedIds.value, ...visibleIds])]
    : selectedIds.value.filter((id) => !visibleIds.includes(id));
}

function statusLabel(status: string) {
  return ({ draft: "草稿", published: "已发布", disabled: "已停用", archived: "已删除" } as Record<string, string>)[status] || status;
}

function formatLabel(format: string) {
  return ({ html: "HTML", json: "JSON", text: "TEXT", auto: "AUTO" } as Record<string, string>)[format] || format.toUpperCase();
}

function targetLabel(target: string) {
  return ({ upstream: "上游", telegram: "TG 频道", both: "上游 + TG" } as Record<string, string>)[target] || target;
}

function compactUrl(value: string) {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname.length > 24 ? `${url.pathname.slice(0, 24)}…` : url.pathname}`;
  } catch { return value.length > 42 ? `${value.slice(0, 42)}…` : value; }
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

async function load() {
  loading.value = true;
  try {
    const [pluginResponse, bindingResponse, upstreamResponse, telegramResponse, tgSourceResponse] = await Promise.all([
      $fetch<{ data: ParserPluginRecord[] }>("/api/parser-plugins?includeArchived=true"),
      $fetch<{ data?: Partial<ParserBindings> }>("/api/settings/parser-bindings"),
      $fetch<{ data?: UpstreamDefinition[] }>("/api/settings/upstreams"),
      $fetch<{ data?: { channels?: string[] | null; defaultChannels?: string[]; effectiveChannels?: string[] } }>("/api/settings/telegram"),
      $fetch<{ data?: { directTemplate?: string; jinaTemplate?: string; userAgent?: string } }>("/api/settings/tg-source"),
    ]);
    plugins.value = pluginResponse.data || [];
    configuredUpstreams.value = upstreamResponse.data || [];
    telegramSettings.value = {
      channels: telegramResponse.data?.channels ?? null,
      defaultChannels: telegramResponse.data?.defaultChannels ?? [],
      effectiveChannels: telegramResponse.data?.effectiveChannels ?? (telegramResponse.data?.channels ?? telegramResponse.data?.defaultChannels ?? []),
    };
    tgSourceSettings.value = {
      directTemplate: tgSourceResponse.data?.directTemplate || "",
      jinaTemplate: tgSourceResponse.data?.jinaTemplate || "",
      userAgent: tgSourceResponse.data?.userAgent || "",
    };
    bindings.value = {
      upstream: bindingResponse.data?.upstream || {},
      telegram: bindingResponse.data?.telegram || {},
    };
    selectedIds.value = selectedIds.value.filter((id) => plugins.value.some((plugin) => plugin.id === id));
  } catch (reason: any) {
    error.value = reason?.data?.statusMessage || reason?.message || "加载插件失败";
  } finally {
    loading.value = false;
  }
}

function bindingsFor(pluginId: string): BindingTag[] {
  return pluginBindingMap.value[pluginId.trim().toLowerCase()] || [];
}

function isBound(pluginId: string) {
  return bindingsFor(pluginId).length > 0;
}

async function testCurrent() {
  if (!editing.value || !sampleRawBody.value.trim()) return;
  testing.value = true;
  testMessage.value = "";
  error.value = "";
  try {
    const response = await $fetch<{ data?: { results?: unknown[]; elapsedMs?: number } }>(`/api/parser-plugins/${editing.value}/test`, {
      method: "POST",
      body: { rawBody: sampleRawBody.value, context: { format: sampleFormat.value, keyword: "sample" } },
    });
    testMessage.value = `样本测试成功：${response.data?.results?.length ?? 0} 条结果，耗时 ${response.data?.elapsedMs ?? 0} ms。`;
  } catch (reason: any) {
    error.value = reason?.data?.statusMessage || reason?.message || "样本测试失败";
  } finally {
    testing.value = false;
  }
}

async function save() {
  saving.value = true;
  error.value = "";
  try {
    const id = editing.value;
    await $fetch(id ? `/api/parser-plugins/${id}` : "/api/parser-plugins", {
      method: id ? "PUT" : "POST",
      body: { plugin: { manifest: { ...draft.manifest }, code: draft.code } },
    });
    await load();
    closeEditor();
  } catch (reason: any) {
    error.value = reason?.data?.statusMessage || reason?.message || "保存失败";
  } finally {
    saving.value = false;
  }
}

async function action(plugin: ParserPluginRecord, name: PluginAction) {
  if (name === "archive" && isBound(plugin.id)) {
    error.value = `插件「${plugin.manifest.name}」已绑定到上游或 TG 频道，解除绑定后才能删除。`;
    return;
  }
  if (name === "archive" && !window.confirm(`确定删除「${plugin.manifest.name}」吗？删除后可在垃圾箱中恢复。`)) return;
  busyAction.value = `${plugin.id}:${name}`;
  error.value = "";
  try {
    await $fetch(`/api/parser-plugins/${plugin.id}/${name}`, { method: "POST" });
    await load();
    selectedIds.value = selectedIds.value.filter((id) => id !== plugin.id);
  } catch (reason: any) {
    error.value = reason?.data?.statusMessage || reason?.message || "操作失败";
  } finally {
    busyAction.value = "";
  }
}

async function deleteSelected() {
  if (bulkRunning.value || !deletableSelected.value.length) return;
  const targets = [...deletableSelected.value];
  if (!window.confirm(`确定删除选中的 ${targets.length} 个解析插件吗？删除后可在垃圾箱中恢复。`)) return;
  bulkRunning.value = true;
  error.value = "";
  try {
    for (const plugin of targets) await $fetch(`/api/parser-plugins/${plugin.id}/archive`, { method: "POST" });
    const deletedIds = new Set(targets.map((plugin) => plugin.id));
    selectedIds.value = selectedIds.value.filter((id) => !deletedIds.has(id));
    await load();
  } catch (reason: any) {
    error.value = reason?.data?.statusMessage || reason?.message || "批量删除失败";
  } finally {
    bulkRunning.value = false;
  }
}

function openTransformImport() {
  transformImportInput.value?.click();
}
function exportTransform(id: string, code = draft.code) {
  const blob = new Blob([code], { type: "text/javascript;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${id || "transform"}.js`;
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
  try {
    const code = await file.text();
    if (!code.trim()) throw new Error("JS 文件为空。");
    draft.code = code;
    error.value = "";
  } catch (reason: any) {
    error.value = reason?.message || "JS 文件读取失败。";
  }
}

function openImport() {
  importInput.value?.click();
}

function parseExportedJson(text: string): any {
  const trimmed = text.trim();
  const moduleMatch = /^export\s+default\s+([\s\S]*?);?\s*$/.exec(trimmed);
  try {
    return JSON.parse(moduleMatch ? moduleMatch[1]!.trim() : trimmed);
  } catch {
    throw new Error("仅支持 JSON 或本页面导出的 JS 配置文件，不会执行任意 JavaScript。");
  }
}
async function importPlugins(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    const parsed = parseExportedJson(await file.text());
    const pluginsToImport = Array.isArray(parsed) ? parsed : parsed?.plugins;
    if (!Array.isArray(pluginsToImport) || !pluginsToImport.length) throw new Error("插件包必须包含 plugins 数组");
    await $fetch("/api/parser-plugins/import", { method: "POST", body: { plugins: pluginsToImport } });
    await load();
    error.value = "";
  } catch (reason: any) {
    error.value = reason?.data?.statusMessage || reason?.message || "导入失败";
  }
}

async function exportPlugins() {
  try {
    const data = await $fetch<{ plugins?: unknown[] }>("/api/parser-plugins/export?includeArchived=true");
    const source = `export default ${JSON.stringify(data, null, 2)};\n`;
    const blob = new Blob([source], { type: "text/javascript;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `parser-plugins-${new Date().toISOString().slice(0, 10)}.js`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  } catch (reason: any) {
    error.value = reason?.data?.statusMessage || reason?.message || "导出失败";
  }
}

onMounted(load);
</script>

<style scoped>
.parser-market {
  display: grid;
  gap: 16px;
}
.market-heading {
  align-items: flex-start;
  gap: 20px;
}
.market-heading h2 {
  margin-bottom: 6px;
}
.market-toolbar,
.market-action-buttons,
.plugin-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.market-toolbar {
  justify-content: flex-end;
}
.market-file {
  display: none;
}
.market-query-panel,
.market-actions,
.plugin-list-panel {
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  background: #fff;
}
.market-query-panel {
  padding: 16px 18px 13px;
}
.query-fields {
  display: grid;
  grid-template-columns: minmax(220px, 2fr) repeat(3, minmax(140px, 1fr));
  gap: 12px;
}
.query-fields label,
.plugin-editor-body label {
  display: grid;
  gap: 6px;
  min-width: 0;
  color: #475569;
  font-size: 12px;
  font-weight: 600;
}
.query-fields input,
.query-fields select,
.plugin-editor-body input,
.plugin-editor-body select,
.plugin-editor-body textarea {
  width: 100%;
  box-sizing: border-box;
  min-height: 40px;
  padding: 8px 10px;
  border: 1px solid #cbd5e1;
  border-radius: 7px;
  color: #334155;
  background: #fff;
  font: inherit;
}
.query-fields input:focus-visible,
.query-fields select:focus-visible,
.plugin-editor-body input:focus-visible,
.plugin-editor-body select:focus-visible,
.plugin-editor-body textarea:focus-visible,
.plugin-table input:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}
.input-with-icon {
  position: relative;
  display: block;
}
.input-with-icon svg {
  position: absolute;
  top: 12px;
  left: 10px;
  color: #94a3b8;
  pointer-events: none;
}
.input-with-icon input {
  padding-left: 34px;
}
.query-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 24px;
  margin-top: 10px;
  color: #64748b;
  font-size: 11px;
}
.query-summary .text-button {
  color: #2563eb;
}
.query-buttons {
  display: flex;
  align-items: center;
  gap: 8px;
}
.market-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 18px;
  background: #f8fafc;
}
.selection-summary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  min-width: 0;
}
.selection-count {
  color: #334155;
  font-size: 12px;
  font-weight: 700;
}
.market-actions .field-hint {
  margin: 0;
}
.market-action-buttons .button {
  min-width: 78px;
}
.plugin-list-panel {
  overflow: hidden;
}
.list-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 17px 18px 14px;
}
.list-heading h3 {
  margin: 0;
  color: #1e293b;
  font-size: 14px;
}
.list-heading p {
  margin: 5px 0 0;
  color: #64748b;
  font-size: 11px;
}
.list-selection-note {
  padding: 5px 9px;
  border-radius: 5px;
  color: #1d4ed8;
  background: #eff6ff;
  font-size: 11px;
  white-space: nowrap;
}
.table-scroll {
  overflow-x: auto;
}
.plugin-table {
  width: 100%;
  min-width: 900px;
  border-collapse: collapse;
  color: #334155;
  font-size: 12px;
}
.plugin-table th {
  padding: 10px 14px;
  border-top: 1px solid #eef2f7;
  border-bottom: 1px solid #e2e8f0;
  color: #64748b;
  background: #f8fafc;
  font-size: 10px;
  font-weight: 700;
  text-align: left;
  white-space: nowrap;
}
.plugin-table td {
  height: 72px;
  padding: 10px 14px;
  border-bottom: 1px solid #eef2f7;
  vertical-align: middle;
}
.plugin-table tbody tr:last-child td {
  border-bottom: 0;
}
.plugin-table tbody tr:hover,
.plugin-table tbody tr.selected-row {
  background: #f8fbff;
}
.plugin-table input[type="checkbox"] {
  width: 16px;
  height: 16px;
  min-height: 0;
  margin: 0;
  accent-color: #2563eb;
}
.check-column {
  width: 44px;
  padding-right: 4px !important;
  padding-left: 18px !important;
  text-align: center !important;
}
.plugin-identity,
.version-cell,
.format-cell {
  display: grid;
  gap: 4px;
}
.plugin-identity strong {
  color: #1e293b;
  font-size: 12px;
}
.configured-tag {
  display: inline-flex;
  align-items: center;
  margin-left: 5px;
  padding: 2px 5px;
  border: 1px solid #bfdbfe;
  border-radius: 4px;
  color: #1d4ed8;
  background: #eff6ff;
  font-size: 9px;
  font-weight: 700;
  vertical-align: 1px;
}
.source-type-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  color: #2563eb;
  font-size: 15px;
  font-weight: 700;
}
.configured-row {
  background: #fbfdff;
}
.plugin-identity code {
  color: #64748b;
  font-size: 10px;
}
.plugin-description {
  max-width: 230px;
  overflow: hidden;
  color: #94a3b8;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plugin-binding-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}
.binding-tag {
  display: inline-flex;
  align-items: center;
  max-width: 240px;
  padding: 3px 6px;
  overflow: hidden;
  border-radius: 4px;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  font-weight: 650;
}
.binding-tag.upstream {
  color: #1d4ed8;
  background: #eff6ff;
}
.binding-tag.telegram {
  color: #0f766e;
  background: #ecfeff;
}
.version-cell strong {
  color: #334155;
  font-size: 11px;
}
.version-cell span,
.format-cell span:last-child,
.updated-time {
  color: #64748b;
  font-size: 10px;
  white-space: nowrap;
}
.format-tag {
  width: fit-content;
  padding: 3px 6px;
  border-radius: 4px;
  color: #475569;
  background: #f1f5f9;
  font: 10px ui-monospace, SFMono-Regular, Consolas, monospace;
  font-weight: 700;
}
.status-badge {
  display: inline-flex;
  align-items: center;
  padding: 4px 7px;
  border-radius: 5px;
  font-size: 10px;
  font-weight: 650;
  white-space: nowrap;
}
.status-badge.published {
  color: #047857;
  background: #ecfdf5;
}
.status-badge.draft {
  color: #92400e;
  background: #fffbeb;
}
.status-badge.disabled {
  color: #64748b;
  background: #f1f5f9;
}
.status-badge.archived {
  color: #991b1b;
  background: #fef2f2;
}
.test-warning,
.test-success {
  display: block;
  margin-top: 5px;
  font-size: 10px;
}
.test-warning {
  color: #b45309;
}
.test-success {
  color: #059669;
}
.action-column {
  width: 1%;
  min-width: 250px;
  text-align: right !important;
}
.plugin-actions {
  justify-content: flex-end;
  gap: 6px;
}
.plugin-actions .button {
  gap: 4px;
}
.plugin-empty {
  min-height: 220px;
  border-top: 1px solid #eef2f7;
}
.plugin-empty strong {
  color: #334155;
  font-size: 13px;
}
.plugin-empty span {
  color: #94a3b8;
  font-size: 11px;
}
.market-error {
  margin: 0;
}

.plugin-editor-dialog {
  width: min(900px, calc(100vw - 32px));
  max-width: calc(100vw - 32px);
  max-height: calc(100dvh - 32px);
  margin: auto;
  padding: 0;
  overflow: hidden;
  border: 1px solid #dbe3ec;
  border-radius: 14px;
  background: #fff;
  box-shadow: 0 24px 80px rgba(15, 23, 42, 0.25);
  color: #1e293b;
}
.plugin-editor-dialog::backdrop {
  background: rgba(15, 23, 42, 0.56);
  backdrop-filter: blur(3px);
}
.plugin-editor-dialog[open] {
  display: flex;
}
.plugin-editor-form {
  display: flex;
  flex: 1;
  min-height: 0;
  max-height: calc(100dvh - 32px);
  flex-direction: column;
}
.plugin-editor-header,
.plugin-editor-footer {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 20px 22px;
  flex-shrink: 0;
}
.plugin-editor-header {
  border-bottom: 1px solid #e2e8f0;
}
.plugin-editor-header h2 {
  margin: 4px 0 5px;
  color: #1e293b;
  font-size: 18px;
}
.plugin-editor-header p {
  margin: 0;
  color: #64748b;
  font-size: 11px;
}
.editor-kicker {
  color: #2563eb;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.14em;
}
.plugin-editor-header .icon-button {
  flex-shrink: 0;
}
.plugin-editor-body {
  display: grid;
  gap: 13px;
  min-height: 0;
  padding: 20px 22px;
  overflow-y: auto;
}
.plugin-editor-body textarea {
  resize: vertical;
}
.plugin-editor-body textarea:first-of-type {
  min-height: 240px;
  font: 12px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace;
}
.plugin-editor-body textarea:last-of-type {
  font: 12px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace;
}
.plugin-editor-body .form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.sample-toolbar {
  display: flex;
  align-items: flex-end;
  gap: 12px;
}
.sample-toolbar label {
  width: 180px;
  flex-shrink: 0;
}
.sample-toolbar .field-hint {
  margin-bottom: 9px;
}
.field-hint {
  color: #64748b;
  font-size: 11px;
  line-height: 1.6;
}
.plugin-editor-body > .field-hint {
  margin: -3px 0 0;
}
.test-message {
  margin: 0 !important;
  padding: 9px 10px;
  border-radius: 7px;
  color: #047857;
  background: #ecfdf5;
}
.plugin-editor-footer {
  justify-content: flex-end;
  align-items: center;
  border-top: 1px solid #e2e8f0;
  background: #f8fafc;
}
.button:focus-visible,
.icon-button:focus-visible,
.text-button:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}
@media (max-width: 900px) {
  .query-fields {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .market-actions {
    align-items: flex-start;
    flex-direction: column;
  }
}
@media (max-width: 600px) {
  .market-heading,
  .list-heading,
  .query-summary {
    align-items: flex-start;
    flex-direction: column;
  }
  .market-toolbar {
    justify-content: flex-start;
  }
  .query-fields,
  .plugin-editor-body .form-grid {
    grid-template-columns: 1fr;
  }
  .market-actions,
  .plugin-editor-header,
  .plugin-editor-body,
  .plugin-editor-footer {
    padding-right: 14px;
    padding-left: 14px;
  }
  .market-action-buttons,
  .market-action-buttons .button {
    width: 100%;
  }
  .market-action-buttons .button {
    flex: 1;
  }
  .sample-toolbar {
    align-items: stretch;
    flex-direction: column;
    gap: 5px;
  }
  .sample-toolbar label {
    width: 100%;
  }
  .sample-toolbar .field-hint {
    margin: 0;
  }
  .plugin-editor-footer .button {
    flex: 1;
  }
}

/* Parser market refresh: a quieter, denser admin surface with one clear action hierarchy. */
.parser-market {
  gap: 12px;
  overflow: visible !important;
  border: 0 !important;
  border-radius: 0 !important;
  background: transparent !important;
}
.market-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  padding: 2px 2px 4px;
}
.market-title {
  min-width: 0;
}
.section-kicker {
  display: block;
  margin-bottom: 7px;
  color: #94a3b8;
  font-size: 9px;
  font-weight: 750;
  letter-spacing: .16em;
  line-height: 1;
}
.market-title-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.market-title h2 {
  color: #172033;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -.03em;
}
.market-title p {
  margin-top: 7px;
  color: #7b8798;
  font-size: 11px;
}
.market-live {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid #dbeee7;
  border-radius: 999px;
  color: #087f5b;
  background: #f2fbf7;
  font-size: 10px;
  font-weight: 650;
  white-space: nowrap;
}
.market-live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #10b981;
  box-shadow: 0 0 0 3px #d1fae5;
}
.market-toolbar {
  gap: 7px;
}
.market-toolbar .button {
  min-height: 34px;
  padding: 7px 10px;
  border-color: #dce3eb;
  border-radius: 7px;
  color: #526174;
  background: #fff;
  font-size: 10px;
}
.market-toolbar .button:hover:not(:disabled) {
  border-color: #bfcee1;
  color: #1d4ed8;
  background: #f8fbff;
}
.market-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.market-stat {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 58px;
  padding: 12px 14px;
  border: 1px solid #e8edf3;
  border-radius: 9px;
  background: #fff;
}
.market-stat-label {
  color: #7b8798;
  font-size: 10px;
}
.market-stat strong {
  color: #172033;
  font-size: 20px;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.bound-stat strong {
  color: #0f766e;
}
.market-query-panel,
.market-actions,
.plugin-list-panel {
  border-color: #e5eaf0;
  border-radius: 10px;
  box-shadow: 0 2px 8px rgba(15, 23, 42, .025);
}
.market-query-panel {
  padding: 14px 16px 12px;
}
.query-panel-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.query-panel-heading .section-kicker,
.list-heading .section-kicker {
  margin-bottom: 4px;
}
.query-panel-heading strong {
  display: block;
  color: #253047;
  font-size: 12px;
  font-weight: 700;
}
.query-result {
  color: #94a3b8;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.query-fields {
  grid-template-columns: minmax(260px, 2.2fr) repeat(3, minmax(135px, 1fr));
  gap: 9px;
}
.query-fields label {
  gap: 5px;
  color: #64748b;
  font-size: 10px;
  font-weight: 650;
}
.query-fields input,
.query-fields select {
  min-height: 36px;
  padding: 7px 9px;
  border-color: #dce3eb;
  border-radius: 7px;
  color: #253047;
  background: #fbfcfe;
  font-size: 11px;
}
.query-fields input:hover,
.query-fields select:hover {
  border-color: #bfcee1;
}
.query-fields input:focus,
.query-fields select:focus {
  border-color: #7aa7f8;
  background: #fff;
}
.input-with-icon svg {
  top: 10px;
  left: 9px;
  color: #9aa8b9;
}
.input-with-icon input {
  padding-left: 31px;
}
.query-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
}
.query-helper {
  color: #a1adbb;
  font-size: 10px;
}
.query-buttons {
  gap: 6px;
}
.query-buttons .button {
  min-width: 54px;
}
.market-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 62px;
  padding: 10px 16px;
  background: #fff;
}
.selection-summary {
  gap: 9px;
}
.action-label {
  color: #253047;
  font-size: 11px;
  font-weight: 700;
}
.selection-count {
  padding-left: 9px;
  border-left: 1px solid #e2e8f0;
  color: #7b8798;
  font-size: 10px;
  font-weight: 550;
}
.selection-warning {
  padding: 4px 7px;
  border-radius: 5px;
  color: #a16207;
  background: #fffbeb;
  font-size: 10px;
}
.market-action-buttons {
  gap: 6px;
}
.market-action-buttons .button {
  min-height: 34px;
  padding: 7px 11px;
  border-radius: 7px;
  font-size: 10px;
}
.market-action-buttons .primary {
  box-shadow: 0 2px 4px rgba(37, 99, 235, .16);
}
.plugin-list-panel {
  overflow: hidden;
  background: #fff;
}
.list-heading {
  min-height: 63px;
  padding: 14px 16px 12px;
  border-bottom: 1px solid #edf1f5;
}
.list-heading h3 {
  color: #253047;
  font-size: 13px;
  font-weight: 700;
}
.plugin-table {
  min-width: 1120px;
  color: #3b4758;
  font-size: 11px;
}
.plugin-table th {
  padding: 9px 12px;
  border-top: 0;
  border-bottom-color: #e8edf3;
  color: #8b98a8;
  background: #fbfcfe;
  font-size: 9px;
  letter-spacing: .02em;
}
.plugin-table td {
  height: 68px;
  padding: 9px 12px;
  border-bottom-color: #eef2f6;
}
.plugin-table tbody tr {
  transition: background .15s ease;
}
.plugin-table tbody tr:hover,
.plugin-table tbody tr.selected-row {
  background: #f8fbff;
}
.plugin-table tbody tr:hover .plugin-identity strong {
  color: #1d4ed8;
}
.plugin-identity {
  gap: 3px;
}
.plugin-identity strong {
  color: #253047;
  font-size: 11px;
  transition: color .15s ease;
}
.plugin-identity code {
  color: #8b98a8;
  font-size: 10px;
}
.plugin-description {
  max-width: 220px;
  color: #a0acba;
  font-size: 10px;
}
.binding-column {
  width: 245px;
}
.binding-cell {
  min-width: 245px;
}
.plugin-binding-tags {
  align-items: center;
  max-width: 260px;
  gap: 4px;
  margin-top: 0;
}
.binding-tag {
  max-width: 125px;
  gap: 4px;
  padding: 4px 6px;
  border: 1px solid transparent;
  border-radius: 5px;
  font-size: 10px;
  font-weight: 650;
}
.binding-tag-kind {
  opacity: .68;
  font-size: 9px;
  font-weight: 750;
}
.binding-tag.upstream {
  border-color: #d8e6ff;
  color: #2563eb;
  background: #f4f8ff;
}
.binding-tag.telegram {
  border-color: #ccefeb;
  color: #0f766e;
  background: #f0fdfa;
}
.no-binding {
  color: #b0bac6;
  font-size: 10px;
}
.format-tag {
  padding: 3px 6px;
  border: 1px solid #e6ebf1;
  color: #68778b;
  background: #f8fafc;
}
.status-badge {
  padding: 4px 7px;
  border: 1px solid transparent;
  border-radius: 5px;
  font-size: 9px;
}
.status-badge.published {
  border-color: #ccefe0;
  background: #f1fcf7;
}
.status-badge.draft {
  border-color: #f5e3b8;
  background: #fffdf5;
}
.status-badge.disabled {
  border-color: #e2e8f0;
  background: #f8fafc;
}
.status-badge.archived {
  border-color: #f5d6d6;
  background: #fff8f8;
}
.action-column {
  min-width: 245px;
}
.plugin-actions {
  gap: 4px;
}
.plugin-actions .button {
  min-height: 29px;
  padding: 5px 8px;
  border-radius: 6px;
  font-size: 10px;
}
.plugin-empty {
  min-height: 245px;
  border-top: 0;
}
.market-error {
  padding: 10px 12px;
  border-radius: 7px;
  background: #fff7f7;
}
@media (max-width: 900px) {
  .market-header {
    align-items: flex-start;
    flex-direction: column;
  }
  .market-toolbar {
    justify-content: flex-start;
  }
  .market-stats {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .query-fields {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 600px) {
  .market-title h2 {
    font-size: 20px;
  }
  .market-stats {
    gap: 7px;
  }
  .market-stat {
    min-height: 52px;
    padding: 10px;
  }
  .market-stat strong {
    font-size: 17px;
  }
  .market-stat-label {
    font-size: 9px;
  }
  .query-panel-heading,
  .query-footer {
    align-items: flex-start;
    flex-direction: column;
  }
  .query-fields {
    grid-template-columns: 1fr;
  }
  .query-footer {
    gap: 8px;
  }
  .query-buttons,
  .query-buttons .button {
    width: 100%;
  }
  .query-buttons .button {
    flex: 1;
  }
  .market-actions {
    align-items: stretch;
    flex-direction: column;
    gap: 10px;
  }
  .market-action-buttons,
  .market-action-buttons .button {
    width: 100%;
  }
  .market-action-buttons .button {
    flex: 1;
  }
}
.function-label-line { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.function-file-actions { display: inline-flex; gap: 8px; font-size: 11px; font-weight: 500; }
</style>
