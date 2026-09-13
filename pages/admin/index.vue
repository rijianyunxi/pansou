<template>
  <div class="upstream-app" :data-ready="clientReady ? 'true' : 'false'">
    <AdminAccessGate
      v-if="adminChecking || adminLocked"
      :checking="adminChecking"
      :configured="adminConfigured"
      :busy="adminUnlocking"
      :ready="clientReady"
      :error="authError"
      title="管理员身份验证"
      description="上游地址、请求规则和调试响应属于敏感运维配置。验证成功后会建立 8 小时的独立管理会话。"
      @submit="unlockAdmin"
      @clear-error="authError = ''"
    />
    <template v-else>
    <aside class="console-sidebar">
      <NuxtLink to="/" class="console-brand"
        ><span class="brand-symbol"><ConsoleIcon name="box" :size="22" /></span
        >PanHub <span class="brand-tag">CONSOLE</span></NuxtLink
      >
      <nav aria-label="工作台导航">
        <button
          :class="{ active: view === 'monitor' }"
          @click="setView('monitor')"
        >
          <ConsoleIcon name="activity" />健康监控
        </button>
        <button
          :class="{ active: view === 'sources' }"
          @click="setView('sources')"
        >
          <ConsoleIcon name="box" />上游接口
        </button>
        <button :class="{ active: view === 'accounts' }" @click="setView('accounts')">
          <ConsoleIcon name="user" />TG 账户管理
        </button>
        <button
          :class="{ active: view === 'settings' }"
          @click="setView('settings')"
        >
          <ConsoleIcon name="sliders" />搜索设置
        </button>
        <button class="archive-nav" type="button" @click="openArchive">
          <ConsoleIcon name="trash" :size="16" />垃圾箱
          <span class="nav-count">{{ trashCount }}</span>
        </button>
      </nav>
      <div class="sidebar-bottom">
        <NuxtLink to="/" class="back-search"
          ><ConsoleIcon name="back" />返回搜索首页<ConsoleIcon
            name="external"
            :size="14"
        /></NuxtLink>
        <div class="sidebar-footer">
          <span class="status-dot available"></span>管理员会话已验证<span
            >v1.0</span
          >
        </div>
      </div>
    </aside>

    <div class="console-body">
      <header class="console-topbar">
        <div class="breadcrumbs">
          <ConsoleIcon name="grid" :size="16" /><span>工作空间</span
          ><ConsoleIcon name="chevron" :size="13" /><strong>{{
            viewTitle
          }}</strong>
        </div>
        <div class="topbar-right">
          <span class="local-chip"><span></span>ADMIN SESSION</span>
          <span class="topbar-divider"></span>
          <button class="session-button" type="button" @click="lockAdmin">
            <span class="user-avatar">P</span>
            <span>退出管理</span>
            <ConsoleIcon name="logout" :size="15" />
          </button>
        </div>
      </header>
      <main class="console-main">
        <div v-if="storageError" class="notice error-notice" role="alert">
          <ConsoleIcon name="info" />{{ storageError }}
        </div>

        <template v-if="view === 'sources'">
          <section class="sources-panel directory-panel" aria-label="上游接口目录">
            <h2 class="panel-title">上游接口</h2>
            <div class="source-toolbar directory-toolbar" aria-label="上游查询与操作">
              <label class="source-search"><ConsoleIcon name="search" :size="16" /><input v-model="search" type="search" aria-label="搜索上游名称或地址" placeholder="搜索名称或地址…" /></label>
              <label class="source-type-filter">
                <span>类型</span>
                <select v-model="sourceTypeFilter" aria-label="按上游类型筛选">
                  <option value="all">全部类型</option>
                  <option value="http">HTTP 上游</option>
                  <option value="telegram">TG 上游</option>
                </select>
              </label>
              <button class="button primary directory-add-button" type="button" @click="openEditor()">
                <ConsoleIcon name="plus" :size="15" />新增上游
              </button>
            </div>

            <div class="table-scroll">
              <table class="source-table directory-table">
                <thead><tr><th>上游 / 接口地址</th><th>操作</th></tr></thead>
                <tbody>
                  <tr v-for="source in filteredSources" :key="source.id">
                    <td>
                      <div class="source-identity">
                        <span class="source-avatar" :style="{ '--source-color': source.color }">{{ source.initials }}</span>
                        <div class="source-text">
                          <div class="source-name">
                            {{ source.name }}
                            <span class="method-tag" :class="source.method.toLowerCase()">{{ source.sourceKind === 'telegram' ? 'TG' : source.method }}</span>
                          </div>
                          <div v-if="source.description" class="source-description">{{ source.description }}</div>
                          <div class="source-address" :title="source.url">{{ source.sourceKind === 'telegram' && source.channel ? `@${source.channel}` : displayUrl(source.url) }}</div>
                          <div class="source-tags">
                            <span v-if="source.sourceKind === 'telegram'" class="draft-tag">TG</span>
                            <span v-if="source.driveType" class="draft-tag">{{ source.driveType }}</span>
                            <span v-for="tag in source.tags || []" :key="`${source.id}-${tag}`" class="draft-tag">{{ tag }}</span>
                            <span v-for="type in source.resourceTypes || []" :key="`${source.id}-resource-${type}`" class="draft-tag">{{ type }}</span>
                          </div>
                        </div>
                      </div>
                    </td>
                    <td class="action-column">
                      <div class="row-actions">
                        <button class="button secondary tiny" type="button" @click="openDetail(source)">详情</button>
                        <button class="button secondary tiny" type="button" :disabled="!!runningId" @click="openDebug(source)"><ConsoleIcon name="play" :size="13" />调试</button>
                        <button class="icon-button" type="button" :aria-label="`修改 ${source.name}`" title="修改" @click="openEditor(source)"><ConsoleIcon name="edit" :size="15" /></button>
                        <button class="icon-button danger-icon" type="button" :aria-label="`删除 ${source.name}`" title="删除" @click="requestDeleteSource(source)"><ConsoleIcon name="trash" :size="15" /></button>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
              <div v-if="!filteredSources.length" class="empty-sources"><ConsoleIcon name="search" :size="28" /><h3>没有匹配的上游</h3><p>调整关键词或类型条件。</p><button class="button secondary small" type="button" @click="search = ''; sourceTypeFilter = 'all'">重置筛选</button></div>
            </div>
            <footer class="table-footer"><span><span class="status-dot neutral"></span>{{ filteredSources.length }} / {{ sources.length }} 个来源</span></footer>
          </section>
        </template>
        <TgAccountManager v-else-if="view === 'accounts'" @unauthorized="adminLocked = true" />
        <MonitorPanel v-else-if="view === 'monitor'" @unauthorized="adminLocked = true" @focus-upstream="focusUpstream" @debug-channel="focusTelegramUpstream" />
        <!-- 搜索设置：默认来源与性能参数（服务端持久化） -->
        <section v-else class="sources-panel settings-panel">
          <h2 class="panel-title">搜索设置</h2>
          <p class="panel-description">决定正式搜索的默认来源与性能，保存后立即生效，无需重新部署。</p>
          <div class="detail-content">
            <div class="section-label">
              插件来源 <span class="tiny-muted">参与默认搜索的已启用来源</span>
            </div>
            <label class="settings-plugin-item"><input v-model="useAllPlugins" type="checkbox" :disabled="settingsSaving" />自动使用全部已启用来源（含已发布的自定义上游）</label>
            <div v-if="!useAllPlugins" class="settings-plugin-grid">
              <label v-for="name in pluginOptions" :key="name" class="settings-plugin-item">
                <input
                  type="checkbox"
                  :value="name"
                  v-model="settingsDraft.plugins"
                  :disabled="settingsSaving" />
                <span>{{ name }}</span>
              </label>
            </div>
            <p class="field-hint">关闭自动选择后，仅搜索勾选的已启用来源；TG 频道不受影响。</p>

            
            <div class="section-label settings-section-gap">
              性能参数 <span class="tiny-muted">留空使用服务端默认值</span>
            </div>
            <div class="editor-grid">
              <label class="settings-field">
                插件并发数
                <input
                  v-model="settingsDraft.concurrency"
                  type="number"
                  min="1"
                  max="16"
                  placeholder="默认 10"
                  :disabled="settingsSaving" />
              </label>
              <label class="settings-field">
                插件超时 (ms)
                <input
                  v-model="settingsDraft.pluginTimeoutMs"
                  type="number"
                  min="1000"
                  step="500"
                  placeholder="默认 15000"
                  :disabled="settingsSaving" />
              </label>
            </div>

            <div class="mapping-actions">
              <button
                class="button primary"
                :disabled="settingsSaving || settingsLoading"
                @click="saveSearchSettingsUi"
              >
                <span v-if="settingsSaving" class="spinner"></span>
                <ConsoleIcon v-else name="check" :size="15" />保存设置
              </button>
              <span v-if="settingsError" class="form-error">{{ settingsError }}</span>
            </div>
          </div>
        </section>
        <footer class="console-footer">
          <span
            ><ConsoleIcon name="shield" :size="14" />独立管理员认证 · HTTPS 默认开启 ·
            自定义地址经安全执行器校验</span
          ><span>PanHub / 管理控制台</span>
        </footer>
      </main>
    </div>
    </template>
    <UpstreamDetailDrawer
      v-if="detailDrawerOpen && selected"
      :source="selected"
      :catalog-source="isCatalogSource(selected)"
      :record="selectedRecord"
      :record-status="recordStatus(selected.id)"
      :published-version="selectedRecord?.publishedVersion"
      :validation-text="validationText"
      :can-publish="canPublishSelected"
      :running="!!runningId"
      :keyword="keyword"
      :plugin-secrets="pluginSecrets"
      :secret-name="secretName"
      :secret-value="secretValue"
      @close="detailDrawerOpen = false"
      @edit="openEditor(selected)"
      @debug="openDebug(selected)"
      @delete="requestDeleteSource(selected)"
      @validate="validatePlugin(selected.id)"
      @publish="publishPlugin(selected.id)"
      @disable="disablePlugin(selected.id)"
      @delete-secret="deleteSecret(selected.id, $event)"
      @save-secret="saveSecret(selected.id)"
      @update:secret-name="secretName = $event"
      @update:secret-value="secretValue = $event"
    />
    <UpstreamDebugDrawer
      v-if="debugDrawerOpen && selected"
      :source="selected"
      :report="selectedReport"
      :keyword="keyword"
      :running="!!runningId"
      :response-tab="responseTab"
      :request-url="redactUrl(String(requestPreview.url || selected.url))"
      :debug-text="debugText"
      @close="debugDrawerOpen = false"
      @send="testSource(selected)"
      @copy="copy(debugText)"
      @update:keyword="keyword = $event"
      @update:response-tab="responseTab = $event"
    />
    <UpstreamEditor
      v-if="!adminLocked && editorOpen"
      :source="editingSource"
      @close="editorOpen = false"
      @save="saveSource"
    />
    <div v-if="archiveTarget" class="modal-backdrop confirmation-backdrop" @click.self="archiveTarget = null">
      <form class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="archive-confirm-title" @submit.prevent="confirmArchive">
        <span class="confirm-icon archive"><ConsoleIcon name="trash" :size="22" /></span>
        <h2 id="archive-confirm-title">删除此上游？</h2>
        <p>
          <strong>{{ archiveTarget.definition.manifest.name }}</strong>
          将从活动目录和正式搜索中移除。配置、版本与审计记录会保留，可在垃圾箱中恢复。
        </p>
        <div class="confirm-actions">
          <button class="button secondary" type="button" @click="archiveTarget = null">取消</button>
          <button class="button danger-button" type="submit" :disabled="archiveBusyId === archiveTarget.id">
            <span v-if="archiveBusyId === archiveTarget.id" class="spinner"></span>
            <ConsoleIcon v-else name="trash" :size="15" />确认删除
          </button>
        </div>
      </form>
    </div>
    <div v-if="archiveOpen" class="modal-backdrop" @click.self="archiveOpen = false">
      <section class="archive-dialog" role="dialog" aria-modal="true" aria-labelledby="archive-title">
        <header>
          <div>
            <span class="eyebrow">LIFECYCLE MANAGEMENT</span>
            <h2 id="archive-title">垃圾箱</h2>
            <p>已删除的上游不会参与搜索。可恢复；彻底清除后配置与历史无法找回。</p>
          </div>
          <button class="icon-button" aria-label="关闭垃圾箱" @click="archiveOpen = false">
            <ConsoleIcon name="close" />
          </button>
        </header>
        <div v-if="archiveLoading" class="archive-empty"><span class="spinner"></span>正在加载垃圾箱…</div>
        <div v-else-if="!archivedRecords.length" class="archive-empty">
          <ConsoleIcon name="trash" :size="30" />
          <strong>垃圾箱为空</strong>
          <p>删除的上游会显示在这里。</p>
        </div>
        <ul v-else class="archive-list">
          <li v-for="record in archivedRecords" :key="record.id">
            <span class="source-avatar" style="--source-color: #7c8790">{{ record.definition.manifest.name.charAt(0).toUpperCase() }}</span>
            <div class="archive-item-copy">
              <strong>{{ record.definition.manifest.name }}</strong>
              <span><code>{{ record.id }}</code> · v{{ record.definition.manifest.version }} · {{ formatTime(record.updatedAt) }}</span>
            </div>
            <div class="archive-actions">
              <button class="button secondary small" :disabled="archiveBusyId === record.id" @click="restoreArchived(record.id)">
                <ConsoleIcon name="restore" :size="14" />恢复
              </button>
              <button class="button danger-button small" :disabled="archiveBusyId === record.id" @click="requestPurge(record)">
                <ConsoleIcon name="trash" :size="14" />永久删除
              </button>
            </div>
          </li>
        </ul>
      </section>
    </div>
    <div v-if="purgeTarget" class="modal-backdrop confirmation-backdrop" @click.self="cancelPurge">
      <form class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="purge-title" @submit.prevent="purgeArchived">
        <span class="confirm-icon"><ConsoleIcon name="trash" :size="22" /></span>
        <h2 id="purge-title">永久删除上游？</h2>
        <p>这会删除 <strong>{{ purgeTarget.definition.manifest.name }}</strong> 的配置、版本和审计记录，且无法恢复。</p>
        <label for="purge-confirmation">输入插件 ID <code>{{ purgeTarget.id }}</code> 以确认</label>
        <input id="purge-confirmation" ref="purgeConfirmationInput" v-model="purgeConfirmation" autocomplete="off" :placeholder="purgeTarget.id" />
        <div class="confirm-actions">
          <button class="button secondary" type="button" @click="cancelPurge">取消</button>
          <button class="button destructive" type="submit" :disabled="purgeConfirmation !== purgeTarget.id || archiveBusyId === purgeTarget.id">
            永久删除
          </button>
        </div>
      </form>
    </div>
    <div v-if="notice" class="console-toast" role="status">
      <ConsoleIcon name="info" :size="17" />{{ notice }}
    </div>
  </div>
</template>

<script setup lang="ts">
import AdminAccessGate from "../../components/admin/AdminAccessGate.vue";
import ConsoleIcon from "../../components/upstreams/ConsoleIcon.vue";
import TgAccountManager from "../../components/admin/TgAccountManager.vue";
import MonitorPanel from "../../components/monitor/MonitorPanel.vue";
import UpstreamEditor from "../../components/upstreams/UpstreamEditor.vue";
import UpstreamDetailDrawer from "../../components/upstreams/UpstreamDetailDrawer.vue";
import UpstreamDebugDrawer from "../../components/upstreams/UpstreamDebugDrawer.vue";
import {
  BUILTIN_UPSTREAMS,
  type UpstreamDefinition,
  type UpstreamProbe,
} from "../../config/upstreams";
import type {
  PluginRecord,
  PluginRecordStatus,
} from "../../server/core/plugins/repository";
import { shallowRef } from "vue";
useHead({
  title: "上游管理",
  meta: [
    { name: "robots", content: "noindex, nofollow" },
    {
      name: "viewport",
      content: "width=device-width, initial-scale=1, viewport-fit=cover",
    },
  ],
});
const STORAGE_KEY = "panhub.upstream-console.v2";
const clientReady = ref(false);
const authStatus = await useFetch<{ configured: boolean; locked: boolean }>(
  "/api/auth/admin-status",
  { key: "upstreams-admin-status", server: true },
);
const configuredUpstreams = ref<UpstreamDefinition[]>([]);
function isTelegramSource(source: UpstreamDefinition | null | undefined): boolean {
  return source?.sourceKind === "telegram";
}
function isCatalogSource(source: UpstreamDefinition | null | undefined): boolean {
  return !!source && configuredUpstreams.value.some((item) => item.id === source.id);
}
const pluginRecords = shallowRef<PluginRecord[]>([]);
const archivedRecords = computed(() => {
  const records = pluginRecords.value as PluginRecord[];
  return records.filter((record) => record.status === "archived");
});
const drafts = computed<UpstreamDefinition[]>(() => {
  const configuredIds = new Set(configuredUpstreams.value.map((source) => source.id));
  const records: PluginRecord[] = pluginRecords.value;
  return records
    .filter((record) => record.status !== "archived" && !configuredIds.has(record.id))
    .map((record) => recordToSource(record));
});
const reports = ref<Record<string, UpstreamProbe>>({});
// The server catalog is the single source of truth. TG channels are ordinary
// upstream rows now, not a second client-side directory.
const sources = computed<UpstreamDefinition[]>(() => [
  ...configuredUpstreams.value,
  ...drafts.value.filter((source) => !trashedPluginSet.value.has(source.id)),
]);
const trashedPluginSet = computed(() => new Set(searchSettings.value.trashedPlugins || []));
const trashCount = computed(() => archivedRecords.value.length);
const selectedId = ref("hunhepan");
const selectedRecord = computed(() =>
  pluginRecords.value.find((record) => record.id === selectedId.value),
);
const defaultSource = BUILTIN_UPSTREAMS.find((source) => source.id === "hunhepan")!;
const defaultUnifiedSource: UpstreamDefinition = { ...defaultSource, sourceKind: "http" };
const selected = computed<UpstreamDefinition>(
  () =>
    sources.value.find((s) => s.id === selectedId.value) ||
    sources.value[0] ||
    defaultUnifiedSource,
);
const selectedReport = computed(() => selected.value ? reports.value[selected.value.id] : undefined);
const validationText = computed(() => {
  const record = selectedRecord.value;
  if (!record) return "—";
  return record.validation?.valid && record.validation.version === record.definition.manifest.version
    ? `已通过 · ${record.validation.sampleResultCount ?? 0} 条样本`
    : "待验证";
});
const canPublishSelected = computed(() => {
  const record = selectedRecord.value;
  return !!record?.validation?.valid && record.validation.version === record.definition.manifest.version;
});
const route = useRoute();
const router = useRouter();
type ConsoleView = "sources" | "accounts" | "settings" | "monitor";
const view = computed<ConsoleView>(() => route.query.view === "accounts" ? "accounts" : route.query.view === "settings" ? "settings" : route.query.view === "monitor" ? "monitor" : "sources");
const viewTitle = computed(
  () =>
    ({
      sources: "上游接口",
      accounts: "TG 账户管理",
      settings: "搜索设置",
      monitor: "健康监控",
    } as Record<ConsoleView, string>)[view.value],
);
const responseTab = ref<"unified" | "raw" | "request">("unified");
const search = ref("");
const sourceTypeFilter = ref<"all" | "http" | "telegram">("all");
const runningId = ref("");
const keyword = ref("三体");
const editorOpen = ref(false);
const editingSource = ref<UpstreamDefinition | null>(null);
const detailDrawerOpen = ref(false);
const debugDrawerOpen = ref(false);
const storageError = ref("");
const initialAuthStatus = authStatus.data.value;
const adminChecking = ref(!initialAuthStatus && !authStatus.error.value);
const adminConfigured = ref(initialAuthStatus?.configured ?? true);
const adminLocked = ref(initialAuthStatus?.locked ?? true);
const adminUnlocking = ref(false);
const authError = ref("");
const archiveOpen = ref(false);
const archiveLoading = ref(false);
const archiveBusyId = ref("");
const archiveTarget = ref<PluginRecord | null>(null);
const purgeTarget = ref<PluginRecord | null>(null);
const purgeConfirmation = ref("");
const purgeConfirmationInput = ref<HTMLInputElement | null>(null);
// 管理端搜索设置（服务端持久化）
interface SearchSettingsState {
  plugins: string[] | null;
  channels: string[] | null;
  concurrency: number | null;
  pluginTimeoutMs: number | null;
  trashedPlugins: string[];
}
const searchSettings = ref<SearchSettingsState>({
  plugins: null,
  channels: null,
  concurrency: null,
  pluginTimeoutMs: null,
  trashedPlugins: [],
});
const settingsLoading = ref(false);
const settingsSaving = ref(false);
const settingsError = ref("");
const settingsDraft = ref<{
  plugins: string[];
  concurrency: number | "";
  pluginTimeoutMs: number | "";
}>({ plugins: [], concurrency: "", pluginTimeoutMs: "" });
const pluginOptions = computed(() => [...new Set([...configuredUpstreams.value.map((source) => source.id), ...pluginRecords.value.filter(record => record.publishedVersion && record.status !== "archived").map(record => record.id)])]);
const useAllPlugins = ref(true);
const notice = ref("");
let noticeTimer: ReturnType<typeof setTimeout>;
const filteredSources = computed(() =>
  sources.value.filter((s) => {
    const matchesType = sourceTypeFilter.value === "all" || s.sourceKind === sourceTypeFilter.value;
    const haystack = `${s.name} ${s.url} ${s.sourceKind} ${s.channel || ""} ${(s.tags || []).join(" ")} ${s.driveType || ""} ${(s.resourceTypes || []).join(" ")}`.toLowerCase();
    return matchesType && haystack.includes(search.value.trim().toLowerCase());
  }),
);
const requestPreview = computed(() => ({
  url: selected.value.url,
  method: selected.value.method,
  format: selected.value.format,
  variables: { keyword: keyword.value },
  note: isCatalogSource(selected.value)
    ? "当前请求来自服务端配置；保存后立即生效。"
    : "当前为旧版插件草稿；发布后参与搜索。",
}));
const debugText = computed(() =>
  responseTab.value === "request"
    ? JSON.stringify(redactDebugValue(requestPreview.value), null, 2)
    : responseTab.value === "raw"
      ? selectedReport.value?.raw || "// 未取得响应体"
      : JSON.stringify(selectedReport.value?.results || [], null, 2),
);
function apiErrorMessage(error: any): string {
  const code = error?.statusCode || error?.response?.status;
  if (code === 401) return "管理员密码错误，或管理会话已过期。";
  if (code === 403) return "请求被安全策略拒绝，请从当前站点重新打开控制台。";
  if (code === 429) return "尝试次数过多，请稍后再试。";
  if (code === 503) return "服务端尚未配置 ADMIN_PASSWORD。";
  return error?.data?.statusMessage || error?.message || "服务端操作失败。";
}

function recordToSource(record: PluginRecord): UpstreamDefinition {
  const definition = record.definition;
  const links = definition.response.links;
  const fieldPath = (field: any) => typeof field === "string" ? field : field?.path || field?.selector || "";
  return {
    id: record.id,
    name: definition.manifest.name,
    description: `${pluginStatusText(record.status)} · 当前版本 ${definition.manifest.version}${record.publishedVersion ? ` · 线上版本 ${record.publishedVersion}` : ""}`,
    url: definition.request.url,
    method: definition.request.method,
    format: definition.response.format,
    plugin: record.id,
    adapter: "configured-transform",
    color: "#697fbd",
    initials: definition.manifest.name.charAt(0).toUpperCase(),
    mapping: {
      items: definition.response.items,
      title: fieldPath(definition.response.fields.title),
      url: fieldPath(links.url),
      type: fieldPath(links.type),
      password: fieldPath(links.password),
      linkArray: links.array,
      content: fieldPath(definition.response.fields.content),
      datetime: fieldPath(definition.response.fields.datetime),
    },
    request: {
      query: definition.request.query,
      headers: definition.request.headers,
      bodyType: definition.request.bodyType,
      body: definition.request.body,
      timeoutMs: definition.request.timeoutMs,
      maxResponseBytes: definition.request.maxResponseBytes,
      redirect: definition.request.redirect,
      allowedDomains: definition.request.allowedDomains,
      maxRequestBodyBytes: definition.request.maxRequestBodyBytes,
      secrets: definition.request.secrets,
      stages: definition.request.stages,
    },
    response: { nextPage: definition.response.nextPage },
    ...(definition.response.transform ? { transform: definition.response.transform } : {}),
    builtin: true,
  };
}
async function loadUpstreamCatalog() {
  try {
    const response = await $fetch<{ data?: UpstreamDefinition[] }>("/api/settings/upstreams");
    configuredUpstreams.value = response.data ?? [];
    if (!sources.value.some((source) => source.id === selectedId.value)) selectedId.value = sources.value[0]?.id || "";
  } catch (error: any) {
    configuredUpstreams.value = [];
    storageError.value = apiErrorMessage(error);
  }
}
async function loadPluginRecords() {
  try {
    const response = await $fetch<{ data: PluginRecord[] }>(
      "/api/plugins?includeArchived=true",
    );
    pluginRecords.value = response.data || [];
    adminLocked.value = false;
    storageError.value = "";
  } catch (error: any) {
    const code = error?.statusCode || error?.response?.status;
    if (code === 401) {
      adminLocked.value = true;
      pluginRecords.value = [];
      archiveOpen.value = false;
      return;
    }
    storageError.value = apiErrorMessage(error);
  }
  void loadSearchSettings();
  void loadUpstreamCatalog();
}
async function loadSearchSettings() {
  settingsLoading.value = true;
  try {
    const response = await $fetch<{ data: SearchSettingsState }>(
      "/api/settings/search",
    );
    searchSettings.value = {
      plugins: response.data?.plugins ?? null,
      channels: response.data?.channels ?? null,
      concurrency: response.data?.concurrency ?? null,
      pluginTimeoutMs: response.data?.pluginTimeoutMs ?? null,
      trashedPlugins: response.data?.trashedPlugins ?? [],
    };
    useAllPlugins.value = searchSettings.value.plugins === null;
    settingsDraft.value = {
      plugins: searchSettings.value.plugins ? [...searchSettings.value.plugins] : [],
      concurrency: searchSettings.value.concurrency ?? "",
      pluginTimeoutMs: searchSettings.value.pluginTimeoutMs ?? "",
    };
    settingsError.value = "";
  } catch (error: any) {
    settingsError.value = apiErrorMessage(error);
  } finally {
    settingsLoading.value = false;
  }
}
async function saveSearchSettingsUi() {
  if (settingsSaving.value) return;
  settingsSaving.value = true;
  settingsError.value = "";
  try {
    const concurrency = Number(settingsDraft.value.concurrency);
    const pluginTimeoutMs = Number(settingsDraft.value.pluginTimeoutMs);
    const response = await $fetch<{ data: SearchSettingsState }>(
      "/api/settings/search",
      {
        method: "PUT",
        body: {
          plugins: useAllPlugins.value ? null : [...settingsDraft.value.plugins],
          concurrency:
            settingsDraft.value.concurrency !== "" &&
            Number.isFinite(concurrency) &&
            concurrency > 0
              ? concurrency
              : null,
          pluginTimeoutMs:
            settingsDraft.value.pluginTimeoutMs !== "" &&
            Number.isFinite(pluginTimeoutMs) &&
            pluginTimeoutMs > 0
              ? pluginTimeoutMs
              : null,
        },
      },
    );
    searchSettings.value = {
      plugins: response.data?.plugins ?? null,
      channels: response.data?.channels ?? null,
      concurrency: response.data?.concurrency ?? null,
      pluginTimeoutMs: response.data?.pluginTimeoutMs ?? null,
      trashedPlugins: response.data?.trashedPlugins ?? [],
    };
    notify("搜索设置已保存，下一次搜索立即生效。");
  } catch (error: any) {
    settingsError.value = apiErrorMessage(error);
    notify(apiErrorMessage(error));
  } finally {
    settingsSaving.value = false;
  }
}
async function checkAdminSession() {
  adminChecking.value = true;
  try {
    const status = await $fetch<{ configured: boolean; locked: boolean }>(
      "/api/auth/admin-status",
    );
    adminConfigured.value = status.configured;
    adminLocked.value = status.locked;
    if (!status.locked) await loadPluginRecords();
  } catch (error: any) {
    adminConfigured.value = false;
    adminLocked.value = true;
    authError.value = apiErrorMessage(error);
  } finally {
    adminChecking.value = false;
  }
}
async function unlockAdmin(password: string) {
  if (!password.trim() || adminUnlocking.value) return;
  adminUnlocking.value = true;
  authError.value = "";
  try {
    await $fetch("/api/auth/admin-unlock", {
      method: "POST",
      body: { password },
    });
    await loadPluginRecords();
    notify("管理员控制台已解锁。");
  } catch (error: any) {
    authError.value = apiErrorMessage(error);
  } finally {
    adminUnlocking.value = false;
  }
}
async function lockAdmin() {
  try {
    await $fetch("/api/auth/admin-lock", { method: "POST" });
  } finally {
    pluginRecords.value = [];
    reports.value = {};
    editorOpen.value = false;
    detailDrawerOpen.value = false;
    debugDrawerOpen.value = false;
    archiveOpen.value = false;
    adminLocked.value = true;
    authError.value = "";
  }
}
async function validatePlugin(id: string) {
  if (!keyword.value.trim()) return;
  runningId.value = id;
  try {
    const response = await $fetch<any>(`/api/plugins/${id}/validate`, {
      method: "POST",
      body: { keyword: keyword.value.trim(), actor: "admin-console" },
    });
    reports.value[id] = instructionDebugToProbe(id, { data: response.sample });
    await loadPluginRecords();
    notify("Schema、安全检查和样本解析均已通过。");
  } catch (error: any) {
    await loadPluginRecords();
    notify(apiErrorMessage(error));
  } finally {
    runningId.value = "";
  }
}
async function publishPlugin(id: string) {
  try {
    await $fetch(`/api/plugins/${id}/publish`, { method: "POST" });
    await loadPluginRecords();
    notify("插件已发布，下一次搜索将原子刷新 Registry。");
  } catch (error: any) {
    notify(apiErrorMessage(error));
  }
}
async function disablePlugin(id: string) {
  try {
    await $fetch(`/api/plugins/${id}/disable`, { method: "POST" });
    await loadPluginRecords();
    notify("线上版本已停用，下一次搜索不再调用该插件。");
  } catch (error: any) {
    notify(apiErrorMessage(error));
  }
}
const pluginSecrets = ref<string[]>([]);
const secretName = ref("");
const secretValue = ref("");
async function loadSecrets() {
  const record = selectedRecord.value;
  if (!record) {
    pluginSecrets.value = [];
    return;
  }
  try {
    const response = await $fetch<any>(`/api/plugins/${record.id}/secrets`);
    pluginSecrets.value = response?.data?.names || [];
  } catch {
    pluginSecrets.value = [];
  }
}
async function saveSecret(id: string) {
  try {
    await $fetch(`/api/plugins/${id}/secrets`, {
      method: "PUT",
      body: {
        name: secretName.value.trim(),
        value: secretValue.value,
        actor: "admin-console",
      },
    });
    secretName.value = "";
    secretValue.value = "";
    await loadSecrets();
    notify("密钥已保存到独立存储，调试与正式搜索均会注入。");
  } catch (error: any) {
    notify(apiErrorMessage(error));
  }
}
async function deleteSecret(id: string, name: string) {
  try {
    await $fetch(
      `/api/plugins/${id}/secrets?name=${encodeURIComponent(name)}`,
      { method: "DELETE" }
    );
    await loadSecrets();
    notify("密钥已删除。");
  } catch (error: any) {
    notify(apiErrorMessage(error));
  }
}
watch(selectedId, () => { void loadSecrets(); }, { immediate: true });
function instructionDebugToProbe(sourceId: string, response: any): UpstreamProbe {
  const execution = response?.data || { results: [], traces: [] };
  const traces = (execution.traces || []).map((trace: any) => ({
    ...trace,
    contentType: trace.contentType || "",
  }));
  return {
    sourceId,
    checkedAt: new Date().toISOString(),
    state: execution.results?.length ? "available" : "warning",
    message: execution.results?.length ? `解析到 ${execution.results.length} 条结果` : "请求成功，但没有可用结果",
    elapsedMs: traces.reduce((sum: number, trace: any) => sum + Number(trace.elapsedMs || 0), 0),
    httpStatus: traces.at(-1)?.status ?? null,
    traces,
    raw: execution.raw || JSON.stringify(execution.results || [], null, 2),
    rawTruncated: execution.rawTruncated === true,
    results: execution.results || [],
  };
}
function recordStatus(id: string): PluginRecordStatus | undefined {
  return pluginRecords.value.find((record) => record.id === id)?.status;
}
function pluginStatusText(status?: PluginRecordStatus): string {
  return {
    draft: "草稿",
    validated: "已验证",
    published: "已发布",
    disabled: "已停用",
    archived: "已删除",
  }[status || "draft"];
}
const SENSITIVE_KEY = /(?:authorization|cookie|token|api[-_]?key|secret|password|passwd|credential|signature)/i;
function redactUrl(url: string) {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_KEY.test(key)) parsed.searchParams.set(key, "[REDACTED]");
    }
    return parsed.toString();
  } catch {
    return url;
  }
}
function redactDebugValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDebugValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactDebugValue(child),
    ]),
  );
}
function displayUrl(url: string) {
  return redactUrl(url).replace(/^https?:\/\//, "");
}
function formatTime(time: string) {
  return new Date(time).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function notify(message: string) {
  notice.value = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = ""), 4000);
}
function persist() {
  try {
    const compactReports = Object.fromEntries(
      Object.entries(reports.value).map(([id, r]) => [
        id,
        {
          ...r,
          raw: r.raw.slice(0, 30000),
          rawTruncated: r.rawTruncated || r.raw.length > 30000,
          results: r.results.slice(0, 100),
        },
      ]),
    );
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ reports: compactReports }),
    );
    storageError.value = "";
  } catch {
    storageError.value =
      "浏览器存储不可用或空间不足：当前修改仅保留在本次会话，请勿关闭页面。";
  }
}

onMounted(async () => {
  clientReady.value = true;
  if (adminChecking.value) await checkAdminSession();
  else if (!adminLocked.value) await loadPluginRecords();
  if (adminLocked.value) {
    return;
  }
  await loadUpstreamCatalog();
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    for (const source of sources.value) {
      const r = saved?.reports?.[source.id];
      if (
        r && r.sourceId === source.id &&
        ["available", "warning", "error"].includes(r.state) &&
        typeof r.raw === "string" && typeof r.elapsedMs === "number" &&
        Array.isArray(r.results) && Array.isArray(r.traces) && typeof r.message === "string"
      ) reports.value[source.id] = r;
    }
  } catch {
    storageError.value = "本地诊断记录读取失败，已使用服务端上游目录。";
  }
});
function openDetail(source: UpstreamDefinition) {
  selectedId.value = source.id;
  debugDrawerOpen.value = false;
  detailDrawerOpen.value = true;
}
function openDebug(source: UpstreamDefinition) {
  selectedId.value = source.id;
  detailDrawerOpen.value = false;
  responseTab.value = "unified";
  debugDrawerOpen.value = true;
}
function focusTelegramUpstream(channel: string) {
  const normalized = String(channel || "").replace(/^@/, "").toLowerCase();
  setView("sources");
  nextTick(() => {
    const source = sources.value.find((item) => item.sourceKind === "telegram" && item.channel === normalized);
    if (source) openDetail(source);
  });
}
function focusUpstream(id: string) {
  setView("sources");
  selectedId.value = id;
  nextTick(() => {
    const source = sources.value.find((item) => item.id === id);
    if (source) openDetail(source);
  });
}
function setView(value: ConsoleView) {
  // A success toast belongs to the previous view; do not leave stale
  // feedback over the target management page.
  notice.value = "";
  clearTimeout(noticeTimer);
  void router.push({
    path: "/admin",
    query: value === "sources" ? {} : { view: value },
  });
}

function openEditor(source: UpstreamDefinition | null = null) {
  detailDrawerOpen.value = false;
  editingSource.value = source;
  editorOpen.value = true;
}
async function saveSource(source: UpstreamDefinition) {
  try {
    // All sources are catalog configuration now. The page no longer creates a
    // second "draft plugin" representation for a new upstream; saving is the
    // activation boundary and the next request reads the SQLite row directly.
    await $fetch("/api/settings/upstreams", {
      method: "PUT",
      body: { source },
    });
    await Promise.all([loadUpstreamCatalog(), loadPluginRecords()]);
    notify("上游配置已保存，下一次请求立即生效。");
  } catch (error: any) {
    notify(apiErrorMessage(error));
    return;
  }
  selectedId.value = source.id;
  search.value = "";
}

let disposed = false;
let activeController: AbortController | undefined;
async function testSource(source: UpstreamDefinition) {
  if (runningId.value) return;
  if (!keyword.value.trim()) {
    notify("请输入测试关键词。");
    return;
  }
  runningId.value = source.id;
  activeController = new AbortController();
  const timer = setTimeout(() => activeController?.abort(), 16000);
  try {
    const result = isCatalogSource(source)
      ? await $fetch<UpstreamProbe>("/api/upstreams/probe", {
          method: "POST",
          body: { sourceId: source.id, keyword: keyword.value.trim() },
          signal: activeController.signal,
          retry: 0,
        })
      : instructionDebugToProbe(
          source.id,
          await $fetch<any>(`/api/plugins/${source.id}/debug`, {
            method: "POST",
            body: { keyword: keyword.value.trim() },
            signal: activeController.signal,
            retry: 0,
          }),
        );
    if (disposed) return;
    reports.value[source.id] = result;
    persist();
    notify(`${source.name}：${result.message}`);
  } catch (error: any) {
    if (!disposed) {
      const code = error?.statusCode || error?.response?.status;
      if (code === 401) adminLocked.value = true;
      notify(
        code === 401
          ? "管理员会话已过期，请重新验证管理员身份。"
          : code === 403
            ? "请求被安全策略拒绝，请检查上游白名单和同源配置。"
            : `工作台请求未完成：${error?.data?.statusMessage || error.message}。未将其记为上游异常。`,
      );
    }
  } finally {
    clearTimeout(timer);
    runningId.value = "";
    activeController = undefined;
  }
}
async function requestDeleteSource(source: UpstreamDefinition) {
  if (isTelegramSource(source)) {
    if (!source.channel || !window.confirm(`确定移除「@${source.channel}」吗？`)) return;
    try {
      await $fetch(`/api/settings/upstreams/${encodeURIComponent(source.id)}`, { method: "DELETE", body: { confirmation: source.id, actor: "admin-console" } });
      delete reports.value[source.id];
      await loadUpstreamCatalog();
      notify(`@${source.channel} 已从统一来源列表移除。`);
    } catch (error: any) {
      notify(apiErrorMessage(error));
    }
    return;
  }
  if (isCatalogSource(source)) {
    if (!window.confirm(`确定删除「${source.name}」吗？删除后下一次请求立即停止加载。`)) return;
    try {
      await $fetch(`/api/settings/upstreams/${encodeURIComponent(source.id)}`, {
        method: "DELETE",
        body: { confirmation: source.id, actor: "admin-console" },
      });
      delete reports.value[source.id];
      detailDrawerOpen.value = false;
      debugDrawerOpen.value = false;
      await Promise.all([loadUpstreamCatalog(), loadPluginRecords()]);
      notify("上游已删除，下一次请求立即生效。");
    } catch (error: any) {
      notify(apiErrorMessage(error));
    }
    return;
  }
  const record = pluginRecords.value.find((r) => r.id === source.id);
  if (!record || record.status === "archived") return;
  detailDrawerOpen.value = false;
  archiveTarget.value = record;
}
async function confirmArchive() {
  const target = archiveTarget.value;
  if (!target || archiveBusyId.value) return;
  archiveBusyId.value = target.id;
  try {
    await $fetch(`/api/plugins/${target.id}/archive`, {
      method: "POST",
      body: { actor: "admin-console" },
    });
    delete reports.value[target.id];
    selectedId.value = "hunhepan";
    archiveTarget.value = null;
    await loadPluginRecords();
    persist();
    notify("上游已删除，并将在下一次搜索时从 Registry 移除。");
  } catch (error: any) {
    notify(apiErrorMessage(error));
  } finally {
    archiveBusyId.value = "";
  }
}
async function openArchive() {
  archiveOpen.value = true;
  archiveLoading.value = true;
  try {
    await loadPluginRecords();
  } finally {
    archiveLoading.value = false;
  }
}
async function restoreArchived(id: string) {
  if (archiveBusyId.value) return;
  archiveBusyId.value = id;
  try {
    await $fetch(`/api/plugins/${id}/restore`, {
      method: "POST",
      body: { actor: "admin-console" },
    });
    await loadPluginRecords();
    archiveOpen.value = false;
    selectedId.value = id;
    notify("上游已从垃圾箱恢复为草稿状态，请验证后再重新发布。");
    openDetail(sources.value.find((source) => source.id === id) || selected.value);
  } catch (error: any) {
    notify(apiErrorMessage(error));
  } finally {
    archiveBusyId.value = "";
  }
}
async function requestPurge(record: PluginRecord) {
  purgeTarget.value = record;
  purgeConfirmation.value = "";
  await nextTick(() => purgeConfirmationInput.value?.focus());
}
function cancelPurge() {
  if (archiveBusyId.value) return;
  purgeTarget.value = null;
  purgeConfirmation.value = "";
}
async function purgeArchived() {
  const target = purgeTarget.value;
  if (
    !target ||
    purgeConfirmation.value !== target.id ||
    archiveBusyId.value
  ) return;
  archiveBusyId.value = target.id;
  try {
    await $fetch(`/api/plugins/${target.id}`, {
      method: "DELETE",
      body: {
        confirmation: purgeConfirmation.value,
        actor: "admin-console",
      },
    });
    purgeTarget.value = null;
    purgeConfirmation.value = "";
    delete reports.value[target.id];
    await loadPluginRecords();
    persist();
    notify("上游及其全部历史记录已永久删除。");
  } catch (error: any) {
    notify(apiErrorMessage(error));
  } finally {
    archiveBusyId.value = "";
  }
}
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify("已复制到剪贴板。");
  } catch {
    notify("无法访问剪贴板，请手动选择并复制。");
  }
}
function closeTopmostOverlay(event: KeyboardEvent) {
  if (event.key !== "Escape" || archiveBusyId.value) return;
  if (purgeTarget.value) cancelPurge();
  else if (archiveTarget.value) archiveTarget.value = null;
  else if (debugDrawerOpen.value) debugDrawerOpen.value = false;
  else if (detailDrawerOpen.value) detailDrawerOpen.value = false;
  else if (archiveOpen.value) archiveOpen.value = false;
}
watch(
  () =>
    archiveOpen.value ||
    detailDrawerOpen.value ||
    debugDrawerOpen.value ||
    !!archiveTarget.value ||
    !!purgeTarget.value,
  (open) => {
    if (import.meta.client) document.body.style.overflow = open ? "hidden" : "";
  },
);
onMounted(() => window.addEventListener("keydown", closeTopmostOverlay));
onBeforeUnmount(() => {
  window.removeEventListener("keydown", closeTopmostOverlay);
  document.body.style.overflow = "";
  disposed = true;
  activeController?.abort();
  clearTimeout(noticeTimer);
});
</script>

<style src="../../assets/upstream-console.css"></style>
