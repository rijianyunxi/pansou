<template>
  <div class="upstream-app" :data-ready="clientReady ? 'true' : 'false'">
    <AdminAccessGate v-if="adminChecking || adminLocked" :checking="adminChecking" :configured="adminConfigured"
      :busy="adminUnlocking" :ready="clientReady" :error="authError" title="进入管理后台"
      description="管理配置、来源请求与诊断数据属于敏感信息。验证成功后将建立 8 小时管理会话。" @submit="unlockAdmin" @clear-error="authError = ''" />
    <template v-else>
      <aside class="console-sidebar">
        <NuxtLink to="/" class="console-brand"><span class="brand-symbol">
            <ConsoleIcon name="box" :size="22" />
          </span>PanHub <span class="brand-tag">CONSOLE</span></NuxtLink>
        <nav aria-label="后台导航">
          <NuxtLink to="/admin/monitor" :class="['console-nav-link', { active: view === 'monitor' }]">
            <ConsoleIcon name="activity" />运行监控
          </NuxtLink>
          <NuxtLink to="/admin/sources" :class="['console-nav-link', { active: view === 'sources' }]">
            <ConsoleIcon name="box" />来源管理
          </NuxtLink>
          <NuxtLink to="/admin/users" class="console-nav-link">
            <ConsoleIcon name="user" />用户管理
          </NuxtLink>
          <NuxtLink to="/admin/logs" class="console-nav-link">
            <ConsoleIcon name="activity" />搜索日志
          </NuxtLink>
          <NuxtLink to="/admin/policies" class="console-nav-link">
            <ConsoleIcon name="sliders" />搜索策略
          </NuxtLink>
        </nav>
      </aside>

      <div class="console-body">
        <header class="console-topbar">
          <div class="breadcrumbs">
            <ConsoleIcon name="grid" :size="16" /><span>管理后台</span>
            <ConsoleIcon name="chevron" :size="13" /><strong>{{
              viewTitle
              }}</strong>
          </div>
          <div class="topbar-right">
            <span class="local-chip"><span></span>ADMIN SESSION</span>
            <span class="topbar-divider"></span>
            <NuxtLink to="/" class="back-search">
              <ConsoleIcon name="external" :size="14" />返回搜索
            </NuxtLink>
            <button class="session-button" type="button" @click="lockAdmin">
              <span class="user-avatar">P</span>
              <span>退出后台</span>
              <ConsoleIcon name="logout" :size="15" />
            </button>
          </div>
        </header>
        <main class="console-main" :class="{ 'console-main-sources': view === 'sources' }">
          <div v-if="storageError" class="notice error-notice" role="alert">
            <ConsoleIcon name="info" />{{ storageError }}
          </div>

          <template v-if="view === 'sources'">
            <SourceTemplateEditor />
            <section class="sources-panel directory-panel" aria-label="来源管理目录">
              <div class="source-toolbar directory-toolbar" aria-label="来源查询与操作">
                <label class="source-search">
                  <ConsoleIcon name="search" :size="17" /><input v-model="search" type="search" aria-label="搜索来源名称或地址"
                    placeholder="搜索来源名称、地址或标签…" />
                </label>
                <button class="button secondary directory-trash-button" type="button" @click="openArchive">
                  <ConsoleIcon name="trash" :size="15" />回收站
                  <span class="nav-count">{{ trashCount }}</span>
                </button>
                <button class="button primary directory-add-button" type="button" @click="openEditor()">
                  <ConsoleIcon name="plus" :size="15" />新增来源
                </button>
              </div>
              <div class="table-scroll">
                <table class="source-table directory-table">
                  <thead>
                    <tr>
                      <th class="source-index-column">序号</th>
                      <th>来源</th>
                      <th>接入方式</th>
                      <th>请求地址</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(source, sourceIndex) in filteredSources" :key="source.id">
                      <td class="source-index-cell" data-label="序号">{{ sourceIndex + 1 }}</td>
                      <td class="source-summary-cell" data-label="来源">
                        <div class="source-identity">
                          <span class="source-avatar" :style="{ '--source-color': sourceColor(source) }">{{ sourceInitials(source)
                            }}</span>
                          <div class="source-text">
                            <div class="source-name">{{ source.name }}</div>
                            <div v-if="source.description" class="source-description">{{ source.description }}</div>
                          </div>
                        </div>
                      </td>
                      <td class="source-kind-cell" data-label="接入方式">
                        <span class="source-kind-badge resource-source-badge">
                          <ConsoleIcon name="globe" :size="13" />
                          资源源
                        </span>
                        <span class="source-kind-meta">{{ source.method }} · {{ source.format.toUpperCase() }}</span>
                      </td>
                      <td class="source-endpoint-cell" data-label="请求地址">
                        <a class="source-endpoint mono" :href="buildSourceDebugUrl(source, keyword)" target="_blank"
                          rel="noopener noreferrer" :title="sourceDebugLinkTitle(source)"
                          :aria-label="`在新标签打开 ${source.name} 的完整调试请求地址`">
                          <span class="source-endpoint-text">{{ displayUrl(buildSourceDebugUrl(source, keyword))
                            }}</span>
                          <ConsoleIcon name="external" :size="13" />
                        </a>
                      </td>
                      <td class="action-column" data-label="操作">
                        <div class="row-actions">
                          <button class="button secondary tiny" type="button" @click="openDetail(source)">详情</button>
                          <button class="button secondary tiny" type="button" :disabled="!!runningId"
                            @click="openDebug(source)">
                            <ConsoleIcon name="play" :size="13" />测试
                          </button>
                          <button class="icon-button" type="button" :aria-label="`修改 ${source.name}`" title="修改"
                            @click="openEditor(source)">
                            <ConsoleIcon name="edit" :size="15" />
                          </button>
                          <button class="icon-button danger-icon" type="button" :aria-label="`删除 ${source.name}`"
                            title="删除" @click="requestDeleteSource(source)">
                            <ConsoleIcon name="trash" :size="15" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <div v-if="!filteredSources.length" class="empty-sources">
                  <ConsoleIcon name="search" :size="28" />
                  <h3>没有匹配的来源</h3>
                  <p>修改关键词。</p><button class="button secondary small" type="button"
                    @click="search = ''">重置筛选</button>
                </div>
              </div>
              <footer class="table-footer"><span><span class="status-dot neutral"></span>{{ filteredSources.length }} /
                  {{ sources.length }} 个来源</span></footer>
            </section>
          </template>
          <MonitorPanel v-else-if="view === 'monitor'" @unauthorized="adminLocked = true"
            @focus-upstream="focusUpstream" @debug-channel="focusTelegramUpstream" />
        </main>
      </div>
    </template>
    <UpstreamDetailDrawer v-if="detailDrawerOpen && selected" :source="selected" :running="!!runningId"
      @close="detailDrawerOpen = false" @edit="openEditor(selected)"
      @debug="openDebug(selected)" @delete="requestDeleteSource(selected)" />
    <UpstreamDebugDialog v-if="debugDialogOpen && selected" :source="selected" :report="selectedReport"
      :keyword="keyword" :running="!!runningId" @close="debugDialogOpen = false" @send="testSource(selected)"
      @update:keyword="keyword = $event" />
    <UpstreamEditor v-if="!adminLocked && editorOpen" :source="editingSource" @close="editorOpen = false"
      @save="saveSource" />
    <div v-if="archiveOpen" class="modal-backdrop" @click.self="closeArchive">
      <section class="archive-dialog" role="dialog" aria-modal="true" aria-labelledby="archive-title">
        <header>
          <div>
            <span class="eyebrow">LIFECYCLE MANAGEMENT</span>
            <h2 id="archive-title">回收站</h2>
            <p>已移除的 Telegram 频道不会参与搜索，可恢复或永久删除。</p>
          </div>
          <button class="icon-button" aria-label="关闭回收站" @click="closeArchive">
            <ConsoleIcon name="close" />
          </button>
        </header>
        <div v-if="archiveLoading" class="archive-empty"><span class="spinner"></span>正在加载回收站…</div>
        <div v-else-if="!archivedChannels.length" class="archive-empty">
          <ConsoleIcon name="trash" :size="30" />
          <strong>回收站为空</strong>
          <p>已移除的 Telegram 频道会显示在这里。</p>
        </div>
        <ul v-else class="archive-list">
          <li v-for="channel in archivedChannels" :key="`telegram:${channel.channel}`">
            <span class="source-avatar" style="--source-color: #229ed9">TG</span>
            <div class="archive-item-copy">
              <a class="archive-channel-link" :href="`https://t.me/s/${channel.channel}`" target="_blank"
                rel="noopener noreferrer" :aria-label="`在新标签页打开 Telegram 频道 @${channel.channel}`"
                :title="`打开 https://t.me/s/${channel.channel}`">
                <span class="archive-channel-name">@{{ channel.channel }}</span>
                <ConsoleIcon name="external" :size="13" />
              </a>
              <span class="archive-channel-meta">{{ channel.origin === "builtin" ? "内置来源" : "自定义来源" }} · 已移除</span>
            </div>
            <div class="archive-actions">
              <button class="button secondary small" :disabled="!!archiveBusyId"
                @click="restoreArchivedChannel(channel.channel)">
                <ConsoleIcon name="restore" :size="14" />恢复
              </button>
              <button class="button danger-button small" :disabled="!!archiveBusyId"
                @click="requestPurgeArchivedChannel(channel)">
                <ConsoleIcon name="trash" :size="14" />永久删除
              </button>
            </div>
          </li>
        </ul>
      </section>
    </div>
    <div v-if="purgeTarget" class="modal-backdrop" @click.self="cancelPurgeArchivedChannel">
      <section class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="purge-channel-title">
        <div class="confirm-icon">
          <ConsoleIcon name="trash" :size="22" />
        </div>
        <h2 id="purge-channel-title">永久删除频道？</h2>
        <p>
          此操作会永久删除 <code>@{{ purgeTarget.channel }}</code> 的频道配置、解析器绑定和健康历史，且无法恢复。
        </p>
        <label for="purge-channel-confirmation">请输入 <code>@{{ purgeTarget.channel }}</code> 确认</label>
        <input id="purge-channel-confirmation" v-model="purgeConfirmation" type="text" autocomplete="off"
          spellcheck="false" :placeholder="`@${purgeTarget.channel}`" @keydown.enter="confirmPurgeArchivedChannel" />
        <div class="confirm-actions">
          <button class="button secondary" type="button" :disabled="!!archiveBusyId"
            @click="cancelPurgeArchivedChannel">取消</button>
          <button class="button destructive" type="button" :disabled="!canConfirmPurge || !!archiveBusyId"
            @click="confirmPurgeArchivedChannel">
            <span v-if="archiveBusyId" class="spinner"></span>
            <ConsoleIcon v-else name="trash" :size="15" />永久删除
          </button>
        </div>
      </section>
    </div>
    <div v-if="notice" class="console-toast" role="status">
      <ConsoleIcon name="info" :size="17" />{{ notice }}
    </div>
  </div>
</template>

<script setup lang="ts">
import AdminAccessGate from "../../components/admin/AdminAccessGate.vue";
import ConsoleIcon from "../../components/upstreams/ConsoleIcon.vue";
import SourceTemplateEditor from "../../components/upstreams/SourceTemplateEditor.vue";
import MonitorPanel from "../../components/monitor/MonitorPanel.vue";
import UpstreamEditor from "../../components/upstreams/UpstreamEditor.vue";
import UpstreamDetailDrawer from "../../components/upstreams/UpstreamDetailDrawer.vue";
import UpstreamDebugDialog from "../../components/upstreams/UpstreamDebugDialog.vue";
import type { UpstreamDefinition, UpstreamProbe } from "../../types/source";
import { buildSourceDebugUrl } from "../../utils/upstreamDebugUrl";
import { shallowRef } from "vue";
useHead({
  title: "管理后台",
  meta: [
    { name: "robots", content: "noindex, nofollow" },
    {
      name: "viewport",
      content: "width=device-width, initial-scale=1, viewport-fit=cover",
    },
  ],
});
const clientReady = ref(false);
const authStatus = await useFetch<{ configured: boolean; locked: boolean }>(
  "/api/auth/admin-status",
  { key: "admin-auth-status", server: true },
);
const configuredUpstreams = ref<UpstreamDefinition[]>([]);
type ArchivedTelegramChannel = {
  channel: string;
  origin: "builtin" | "custom";
  enabled: boolean;
  deleted: boolean;
};
const monitorChannels = shallowRef<ArchivedTelegramChannel[]>([]);
const archivedChannels = computed(() => monitorChannels.value.filter((channel) => channel.deleted));
const reports = ref<Record<string, UpstreamProbe>>({});
// The unified catalog is the only source directory. Transform functions are source configuration, not separate sources.
const sources = configuredUpstreams;
const trashCount = computed(() => archivedChannels.value.length);
const selectedId = ref("");
const defaultUnifiedSource: UpstreamDefinition = {
  id: "",
  name: "",
  description: "",
  url: "https://example.invalid",
  method: "GET",
  format: "json",
  transform: "",
  enabled: false,
};
const selected = computed<UpstreamDefinition>(
  () =>
    sources.value.find((s) => s.id === selectedId.value) ||
    sources.value[0] ||
    defaultUnifiedSource,
);
const selectedReport = computed(() => selected.value ? reports.value[selected.value.id] : undefined);
const route = useRoute();
type ConsoleView = "sources" | "monitor";
const rawRouteView = Array.isArray(route.params.view) ? route.params.view[0] : route.params.view;
if (!rawRouteView || !["sources", "monitor"].includes(String(rawRouteView))) {
  await navigateTo({ path: "/admin/sources", query: route.query }, { replace: true });
}
const view = computed<ConsoleView>(() => {
  const routeView = Array.isArray(route.params.view) ? route.params.view[0] : route.params.view;
  return routeView === "monitor" ? routeView : "sources";
});
const viewTitle = computed(
  () =>
    ({
      sources: "来源管理",
      monitor: "运行监控",
    } as Record<ConsoleView, string>)[view.value],
);
const search = ref("");
const runningId = ref("");
const keyword = ref("三体");
const editorOpen = ref(false);
const editingSource = ref<UpstreamDefinition | null>(null);
const detailDrawerOpen = ref(false);
const debugDialogOpen = ref(false);
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
const purgeTarget = ref<ArchivedTelegramChannel | null>(null);
const purgeConfirmation = ref("");
const canConfirmPurge = computed(() =>
  purgeConfirmation.value.trim().replace(/^@/, "").toLowerCase() === purgeTarget.value?.channel,
);
const notice = ref("");
useHead({ title: () => viewTitle.value });
let noticeTimer: ReturnType<typeof setTimeout>;
const SOURCE_COLORS = ["#4085b8", "#5b67c7", "#0f766e", "#b45309", "#9d174d", "#6d28d9"];
function sourceInitials(source: UpstreamDefinition): string {
  const name = source.name.trim();
  return name ? Array.from(name)[0]!.toUpperCase() : "S";
}
function sourceColor(source: UpstreamDefinition): string {
  let hash = 0;
  for (const char of source.id || source.name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return SOURCE_COLORS[hash % SOURCE_COLORS.length]!;
}

const filteredSources = computed(() =>
  sources.value.filter((s) => {
    const haystack = `${s.id} ${s.name} ${s.url} ${s.description}`.toLowerCase();
    return haystack.includes(search.value.trim().toLowerCase());
  }),
);
function apiErrorMessage(error: any): string {
  const code = error?.statusCode || error?.response?.status;
  if (code === 401) return "管理员密码错误，或管理会话已过期。";
  if (code === 403) return "请求被安全策略拒绝，请从当前站点重新打开控制台。";
  if (code === 429) return "尝试次数过多，请稍后再试。";
  if (code === 503) return "服务端尚未配置 ADMIN_PASSWORD。";
  return error?.data?.statusMessage || error?.message || "服务端操作失败。";
}

async function loadUpstreamCatalog() {
  try {
    const response = await $fetch<{ data?: UpstreamDefinition[] }>("/api/settings/upstreams");
    configuredUpstreams.value = response.data ?? [];
    storageError.value = "";
    if (!sources.value.some((source) => source.id === selectedId.value)) selectedId.value = sources.value[0]?.id || "";
  } catch (error: any) {
    configuredUpstreams.value = [];
    if ((error?.statusCode || error?.response?.status) === 401) {
      adminLocked.value = true;
      detailDrawerOpen.value = false;
      debugDialogOpen.value = false;
    }
    storageError.value = apiErrorMessage(error);
  }
}
async function loadArchivedChannels() {
  try {
    const response = await $fetch<{ data?: { channels?: ArchivedTelegramChannel[] } }>(
      "/api/monitor?includeDeleted=true",
      { cache: "no-store" },
    );
    monitorChannels.value = Array.isArray(response.data?.channels)
      ? response.data.channels
      : [];
  } catch (error: any) {
    monitorChannels.value = [];
    const code = error?.statusCode || error?.response?.status;
    if (code === 401) {
      adminLocked.value = true;
      archiveOpen.value = false;
      return;
    }
    storageError.value = apiErrorMessage(error);
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
    if (!status.locked) await loadUpstreamCatalog();
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
    adminLocked.value = false;
    // `useFetch` data is cached by key and the page is remounted when switching
    // console routes. Keep the cached status in sync with the newly issued cookie,
    // otherwise a route change reuses the initial locked=true SSR result.
    authStatus.data.value = {
      configured: adminConfigured.value,
      locked: false,
    };
    await refreshNuxtData("public-admin-status");
    await Promise.all([loadUpstreamCatalog(), loadArchivedChannels()]);
    // The recycle bin is an in-place modal under source management.

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
    configuredUpstreams.value = [];
    monitorChannels.value = [];
    reports.value = {};
    editorOpen.value = false;
    detailDrawerOpen.value = false;
    debugDialogOpen.value = false;
    archiveOpen.value = false;
    adminLocked.value = true;
    authStatus.data.value = {
      configured: adminConfigured.value,
      locked: true,
    };
    await refreshNuxtData("public-admin-status");
    authError.value = "";
  }
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
function displayUrl(url: string) {
  const safeUrl = redactUrl(url).replace(/^https?:\/\//, "");
  try {
    return decodeURI(safeUrl);
  } catch {
    return safeUrl;
  }
}
function sourceDebugLinkTitle(source: UpstreamDefinition): string {
  const url = buildSourceDebugUrl(source, keyword.value);
  return source.method === "POST"
    ? `POST 参数浏览器预览（实际请求仍使用 POST Body）\n${url}`
    : `在新标签打开完整 GET 请求\n${url}`;
}
function notify(message: string) {
  notice.value = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = ""), 4000);
}
onMounted(async () => {
  clientReady.value = true;
  if (adminChecking.value) await checkAdminSession();
  else if (!adminLocked.value) await loadUpstreamCatalog();
  if (adminLocked.value) {
    return;
  }
  await loadArchivedChannels();
});
function openDetail(source: UpstreamDefinition) {
  selectedId.value = source.id;
  debugDialogOpen.value = false;
  detailDrawerOpen.value = true;
}
function openDebug(source: UpstreamDefinition) {
  selectedId.value = source.id;
  detailDrawerOpen.value = false;
  debugDialogOpen.value = true;
}
function focusTelegramUpstream(channel: string) {
  const normalized = String(channel || "").replace(/^@/, "").toLowerCase();
  const source = sources.value.find((item) => item.id === normalized);
  if (source) openDebug(source);
  else notify(`未找到频道 @${normalized} 的来源配置。`);
}
function focusUpstream(id: string) {
  const source = sources.value.find((item) => item.id === id);
  if (source) openDetail(source);
}
function openEditor(source: UpstreamDefinition | null = null) {
  detailDrawerOpen.value = false;
  editingSource.value = source;
  editorOpen.value = true;
}
async function saveSource(source: UpstreamDefinition) {
  try {
    // All sources are catalog configuration now. The page no longer creates a
    // second "draft source" representation for a new upstream; saving is the
    // activation boundary and the next request reads the SQLite row directly.
    await $fetch("/api/settings/upstreams", {
      method: "PUT",
      body: { source },
    });
    await loadUpstreamCatalog();
    notify("来源配置已保存，下一次请求立即生效。");
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
    const result = await $fetch<UpstreamProbe>("/api/upstreams/test", {
      method: "POST",
      body: { sourceId: source.id, kw: keyword.value.trim() },
      signal: activeController.signal,
      retry: 0,
    });
    if (disposed) return;
    reports.value[source.id] = result;
    notify(`${source.name}：${result.message}`);
  } catch (error: any) {
    if (!disposed) {
      const code = error?.statusCode || error?.response?.status;
      if (code === 401) adminLocked.value = true;
      notify(
        code === 401
          ? "管理员会话已过期，请重新验证管理员身份。"
          : code === 403
            ? "请求被安全策略拒绝，请检查来源白名单和同源配置。"
            : `管理后台请求未完成：${error?.data?.statusMessage || error.message}。未将其记为来源异常。`,
      );
    }
  } finally {
    clearTimeout(timer);
    runningId.value = "";
    activeController = undefined;
  }
}
async function requestDeleteSource(source: UpstreamDefinition) {
  if (!window.confirm(`确定删除「${source.name}」吗？删除后下一次请求立即停止加载。`)) return;
  try {
    await $fetch(`/api/settings/upstreams/${encodeURIComponent(source.id)}`, {
      method: "DELETE",
      body: { confirmation: source.id, actor: "admin-console" },
    });
    delete reports.value[source.id];
    detailDrawerOpen.value = false;
    debugDialogOpen.value = false;
    await Promise.all([loadUpstreamCatalog(), loadArchivedChannels()]);
    notify("来源已删除，下一次请求立即生效。");
  } catch (error: any) {
    notify(apiErrorMessage(error));
  }
}
async function openArchive() {
  archiveOpen.value = true;
  archiveLoading.value = true;
  try {
    await loadArchivedChannels();
  } finally {
    archiveLoading.value = false;
  }
}
function closeArchive() {
  archiveOpen.value = false;
  purgeTarget.value = null;
  purgeConfirmation.value = "";
}
async function restoreArchivedChannel(channel: string) {
  const busyId = `telegram:${channel}`;
  if (archiveBusyId.value) return;
  archiveBusyId.value = busyId;
  try {
    await $fetch(`/api/tg/channels/${encodeURIComponent(channel)}/enable`, {
      method: "POST",
    });
    await loadArchivedChannels();
    notify(`Telegram 频道 @${channel} 已恢复。`);
  } catch (error: any) {
    notify(apiErrorMessage(error));
  } finally {
    archiveBusyId.value = "";
  }
}
function requestPurgeArchivedChannel(channel: ArchivedTelegramChannel) {
  if (archiveBusyId.value) return;
  purgeTarget.value = channel;
  purgeConfirmation.value = "";
  nextTick(() => document.querySelector<HTMLInputElement>("#purge-channel-confirmation")?.focus());
}
function cancelPurgeArchivedChannel() {
  if (archiveBusyId.value) return;
  purgeTarget.value = null;
  purgeConfirmation.value = "";
}
async function confirmPurgeArchivedChannel() {
  const channel = purgeTarget.value?.channel;
  if (!channel || !canConfirmPurge.value || archiveBusyId.value) return;
  archiveBusyId.value = `telegram:${channel}`;
  try {
    await $fetch(`/api/tg/channels/${encodeURIComponent(channel)}/purge`, {
      method: "DELETE",
      body: { confirmation: channel },
    });
    purgeTarget.value = null;
    purgeConfirmation.value = "";
    await Promise.all([loadArchivedChannels(), loadUpstreamCatalog()]);
    notify(`Telegram 频道 @${channel} 已永久删除。`);
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
  if (purgeTarget.value) cancelPurgeArchivedChannel();
  else if (debugDialogOpen.value) debugDialogOpen.value = false;
  else if (detailDrawerOpen.value) detailDrawerOpen.value = false;
  else if (archiveOpen.value) closeArchive();
}
watch(
  () => archiveOpen.value || !!purgeTarget.value || detailDrawerOpen.value || debugDialogOpen.value,
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
