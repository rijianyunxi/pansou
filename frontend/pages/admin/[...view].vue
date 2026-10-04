<template>
  <div class="admin-page" :data-ready="clientReady ? 'true' : 'false'">
    <div v-if="storageError" class="notice error-notice" role="alert">
      <ConsoleIcon name="info" />{{ storageError }}
    </div>

    <template v-if="view === 'sources'">
      <Card class="sources-panel directory-panel" aria-label="来源管理目录">
        <div
          class="source-toolbar directory-toolbar"
          aria-label="来源查询与操作"
        >
          <label class="source-search">
            <ConsoleIcon name="search" :size="17" /><Input
              v-model="search"
              type="search"
              aria-label="搜索来源名称或地址"
              placeholder="搜索来源名称、地址或标签…"
            />
          </label>
          <Button
            variant="default"
            class="button primary directory-add-button"
            type="button"
            @click="openEditor()"
          >
            <ConsoleIcon name="plus" :size="15" />新增来源
          </Button>
        </div>
        <div class="table-scroll">
          <Table class="source-table directory-table admin-data-table">
            <TableHeader>
              <TableRow>
                <TableHead class="source-index-column">序号</TableHead>
                <TableHead>来源</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>优先级</TableHead>
                <TableHead>请求地址</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow
                v-for="(source, sourceIndex) in filteredSources"
                :key="source.id"
              >
                <TableCell class="source-index-cell" data-label="序号">{{
                  sourceIndex + 1
                }}</TableCell>
                <TableCell class="source-summary-cell" data-label="来源">
                  <div class="source-identity">
                    <span
                      class="source-avatar"
                      :style="{ '--source-color': sourceColor(source) }"
                      >{{ sourceInitials(source) }}</span
                    >
                    <div class="source-text">
                      <div class="source-name">{{ source.name }}</div>
                      <RouterLink
                        v-if="isTelegram(source.url)"
                        to="/admin/crawl"
                        class="source-description"
                        >TG 本地索引 · 查看采集进度</RouterLink
                      >
                      <div v-if="source.description" class="source-description">
                        {{ source.description }}
                      </div>
                    </div>
                  </div>
                </TableCell>
                <TableCell class="source-status-cell" data-label="状态">
                  <div class="source-state-tags">
                    <AdminStatusBadge
                      :state="source.enabled === false ? 'disabled' : 'enabled'"
                    >
                      {{ source.enabled === false ? "已停用" : "已启用" }}
                    </AdminStatusBadge>
                    <AdminStatusBadge
                      :state="sourceCircuitStates[source.id] || 'closed'"
                    >
                      {{ circuitStateLabel(source.id) }}
                    </AdminStatusBadge>
                  </div>
                </TableCell>
                <TableCell class="source-priority-cell" data-label="优先级">
                  <span class="source-priority-badge">{{
                    source.priority ?? 0
                  }}</span>
                </TableCell>
                <TableCell class="source-endpoint-cell" data-label="请求地址">
                  <a
                    class="source-endpoint mono"
                    :href="buildSourceCatalogUrl(source)"
                    target="_blank"
                    rel="noopener noreferrer"
                    :title="sourceCatalogLinkTitle(source)"
                    :aria-label="`在新标签打开 ${source.name} 的默认请求地址`"
                  >
                    <span class="source-endpoint-text">{{
                      displayUrl(buildSourceCatalogUrl(source))
                    }}</span>
                    <ConsoleIcon name="external" :size="13" />
                  </a>
                </TableCell>
                <TableCell class="action-column" data-label="操作">
                  <AdminRowActions>
                    <Button
                      variant="ghost"
                      size="sm"
                      class="row-action-button"
                      :class="{ 'danger-action': source.enabled !== false }"
                      type="button"
                      :aria-label="`${source.enabled === false ? '启用' : '停用'} ${source.name}`"
                      :disabled="!!runningId || !!sourceToggleId"
                      :title="
                        source.enabled === false
                          ? '重新加入搜索来源'
                          : '从搜索来源中停用，配置保留'
                      "
                      @click="toggleSource(source)"
                    >
                      {{ source.enabled === false ? "启用" : "停用" }}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      class="row-action-button"
                      type="button"
                      :aria-label="`查看 ${source.name} 详情`"
                      title="详情"
                      @click="openDetail(source)"
                    >
                      详情
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      class="row-action-button"
                      type="button"
                      :aria-label="`测试 ${source.name}`"
                      title="测试"
                      :disabled="!!runningId"
                      @click="openDebug(source)"
                    >
                      测试
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      class="row-action-button"
                      type="button"
                      :aria-label="`修改 ${source.name}`"
                      title="修改"
                      @click="openEditor(source)"
                    >
                      编辑
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      class="row-action-button danger-action"
                      type="button"
                      :aria-label="`删除 ${source.name}`"
                      title="删除"
                      :disabled="!!runningId || !!sourceToggleId"
                      @click="requestDeleteSource(source)"
                    >
                      删除
                    </Button>
                  </AdminRowActions>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <div v-if="!filteredSources.length" class="empty-sources">
            <ConsoleIcon name="search" :size="28" />
            <h3>没有匹配的来源</h3>
            <p>修改关键词。</p>
            <Button
              variant="outline"
              class="button secondary small"
              type="button"
              @click="search = ''"
              >重置筛选</Button
            >
          </div>
        </div>
        <footer class="table-footer">
          <span
            ><span class="status-dot neutral"></span
            >{{ filteredSources.length }} / {{ sources.length }} 个来源</span
          >
        </footer>
      </Card>
    </template>

    <SourceDetailDrawer
      v-if="detailDrawerOpen && selected"
      :source="selected"
      :running="!!runningId"
      @close="detailDrawerOpen = false"
      @edit="openEditor(selected)"
      @debug="openDebug(selected)"
      @delete="requestDeleteSource(selected)"
    />
    <SourceDebugDialog
      v-if="debugDialogOpen && selected"
      :source="selected"
      :report="selectedReport"
      :keyword="keyword"
      :running="!!runningId"
      @close="debugDialogOpen = false"
      @send="testSource(selected)"
      @update:keyword="keyword = $event"
    />
    <SourceEditor
      v-if="!adminLocked && editorOpen"
      :source="editingSource"
      :saving="sourceSaving"
      :save-error="sourceSaveError"
      @close="closeSourceEditor"
      @save="saveSource"
    />
    <div v-if="notice" class="console-toast" role="status">
      <ConsoleIcon name="info" :size="17" />{{ notice }}
    </div>
  </div>
</template>

<script setup lang="ts">
import AdminRowActions from "@/components/admin/AdminRowActions.vue";
import AdminStatusBadge from "@/components/admin/AdminStatusBadge.vue";
import { Card } from "@/components/admin/ui/card";
import { Button } from "@/components/admin/ui/button";
import { Input } from "@/components/admin/ui/input";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/admin/ui/table";
import { useAdminConfirm } from "@/composables/admin/useAdminConfirm";
const { confirm: confirmAction } = useAdminConfirm();
import { useAdminSession } from "@/composables/admin/useAdminSession";
const { locked: adminLocked, authenticated: adminAuthenticated } =
  useAdminSession();

import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, RouterLink } from "vue-router";
import { navigate, apiFetch, setDocumentHead } from "../../src/appRuntime";
import { buildSourceCatalogUrl } from "../../utils/sourceDebugUrl";

import ConsoleIcon from "../../components/sources/ConsoleIcon.vue";
import SourceEditor from "../../components/sources/SourceEditor.vue";
import SourceDetailDrawer from "../../components/sources/SourceDetailDrawer.vue";
import SourceDebugDialog from "../../components/sources/SourceDebugDialog.vue";
import type { SourceDefinition, SourceProbe } from "../../types/source";
setDocumentHead({
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
const configuredSources = ref<SourceDefinition[]>([]);
type SourceCircuitState = "closed" | "open" | "half-open";
const sourceCircuitStates = ref<Record<string, SourceCircuitState>>({});
const reports = ref<Record<string, SourceProbe>>({});
// The unified catalog is the only source directory. Transform functions are source configuration, not separate sources.
const sources = configuredSources;
const selectedId = ref("");
const defaultUnifiedSource: SourceDefinition = {
  id: "",
  name: "",
  description: "",
  url: "https://example.invalid",
  method: "GET",
  format: "json",
  priority: 0,
  transform: "",
  enabled: false,
};
const selected = computed<SourceDefinition>(
  () =>
    sources.value.find((s) => s.id === selectedId.value) ||
    sources.value[0] ||
    defaultUnifiedSource,
);
const selectedReport = computed(() =>
  selected.value ? reports.value[selected.value.id] : undefined,
);
const route = useRoute();
const view = computed(() => "sources");
const viewTitle = computed(() => "来源管理");
const search = ref("");
const runningId = ref("");
const keyword = ref("三体");
const editorOpen = ref(false);
const sourceSaving = ref(false);
const sourceSaveError = ref("");
const editingSource = ref<SourceDefinition | null>(null);
const detailDrawerOpen = ref(false);
const debugDialogOpen = ref(false);
const storageError = ref("");
const sourceToggleId = ref("");
const notice = ref("");
watch(
  viewTitle,
  (title) => {
    document.title = `${title} - pansou`;
  },
  { immediate: true },
);
let noticeTimer: ReturnType<typeof setTimeout>;
const SOURCE_COLORS = [
  "#4085b8",
  "#5b67c7",
  "#0f766e",
  "#b45309",
  "#9d174d",
  "#6d28d9",
];
function isTelegram(value: string): boolean {
  try {
    return ["t.me", "telegram.me"].includes(new URL(value).hostname);
  } catch {
    return false;
  }
}
function sourceInitials(source: SourceDefinition): string {
  const name = source.name.trim();
  return name ? Array.from(name)[0]!.toUpperCase() : "S";
}
function sourceColor(source: SourceDefinition): string {
  let hash = 0;
  for (const char of source.id || source.name)
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return SOURCE_COLORS[hash % SOURCE_COLORS.length]!;
}
function circuitStateLabel(sourceId: string): string {
  const state = sourceCircuitStates.value[sourceId];
  return state === "open"
    ? "已熔断"
    : state === "half-open"
      ? "半开"
      : "未熔断";
}

const filteredSources = computed(() =>
  sources.value.filter((s) => {
    const haystack =
      `${s.id} ${s.name} ${s.url} ${s.description}`.toLowerCase();
    return haystack.includes(search.value.trim().toLowerCase());
  }),
);
function apiErrorMessage(error: any): string {
  const code = error?.statusCode || error?.response?.status;
  if (code === 401) return "请先登录管理员账号。";
  if (code === 403) return "当前账号没有管理员权限。";
  if (code === 429) return "尝试次数过多，请稍后再试。";
  return error?.data?.statusMessage || error?.message || "服务端操作失败。";
}

async function loadSourceCatalog() {
  try {
    const response = await apiFetch<{
      data?: SourceDefinition[] | { sources?: SourceDefinition[] };
    }>("/api/settings/sources");
    const payload = response?.data;
    configuredSources.value = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.sources)
        ? payload.sources
        : [];
    storageError.value = "";
    if (!sources.value.some((source) => source.id === selectedId.value))
      selectedId.value = sources.value[0]?.id || "";
  } catch (error: any) {
    configuredSources.value = [];
    if ([401, 403].includes(error?.statusCode || error?.response?.status)) {
      adminAuthenticated.value = false;
      adminLocked.value = true;
      detailDrawerOpen.value = false;
      debugDialogOpen.value = false;
    }
    storageError.value = apiErrorMessage(error);
  }
}

const SENSITIVE_KEY =
  /(?:authorization|cookie|token|api[-_]?key|secret|password|passwd|credential|signature)/i;
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
function sourceCatalogLinkTitle(source: SourceDefinition): string {
  return `在新标签打开 ${source.name} 的默认请求地址\n${buildSourceCatalogUrl(source)}`;
}
function notify(message: string) {
  notice.value = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = ""), 4000);
}
onMounted(async () => {
  clientReady.value = true;
  await loadSourceCatalog();
  if (adminLocked.value) {
    return;
  }
  await loadSourceHealth();
  const edit = String(route.query.edit || "");
  const matched = sources.value.find((s) => s.id === edit);
  if (matched) openEditor(matched);
});
function openDetail(source: SourceDefinition) {
  selectedId.value = source.id;
  debugDialogOpen.value = false;
  detailDrawerOpen.value = true;
}
function openDebug(source: SourceDefinition) {
  selectedId.value = source.id;
  detailDrawerOpen.value = false;
  debugDialogOpen.value = true;
}
function closeSourceEditor() {
  if (!sourceSaving.value) editorOpen.value = false;
}
function openEditor(source: SourceDefinition | null = null) {
  sourceSaveError.value = "";
  detailDrawerOpen.value = false;
  editingSource.value = source;
  editorOpen.value = true;
}
async function saveSource(source: SourceDefinition) {
  if (sourceSaving.value) return;
  sourceSaving.value = true;
  sourceSaveError.value = "";
  try {
    // All sources are catalog configuration now. The page no longer creates a
    // second "draft source" representation for a new source; saving is the
    // activation boundary and the next request reads the PostgreSQL row directly.
    await apiFetch("/api/settings/sources", {
      method: "PUT",
      body: { source },
    });
    await loadSourceCatalog();
    editorOpen.value = false;
    notify("来源配置已保存，下一次请求立即生效。");
  } catch (error: any) {
    sourceSaveError.value = apiErrorMessage(error);
    return;
  } finally {
    sourceSaving.value = false;
  }
  selectedId.value = source.id;
  search.value = "";
}

async function toggleSource(source: SourceDefinition) {
  if (sourceToggleId.value || runningId.value) return;
  const enabled = source.enabled === false;
  sourceToggleId.value = source.id;
  try {
    await apiFetch(
      `/api/settings/sources/${encodeURIComponent(source.id)}/${enabled ? "enable" : "disable"}`,
      {
        method: "POST",
      },
    );
    await Promise.all([loadSourceCatalog(), loadSourceHealth()]);
    notify(
      `${source.name} 已${enabled ? "启用" : "停用"}，下一次请求立即生效。`,
    );
  } catch (error: any) {
    notify(apiErrorMessage(error));
  } finally {
    sourceToggleId.value = "";
  }
}
async function loadSourceHealth() {
  try {
    const response = await apiFetch<{
      data?: {
        sources?: Array<{
          id?: string;
          health?: { circuitState?: SourceCircuitState | null } | null;
        }>;
      };
    }>("/api/monitor", { cache: "no-store" });
    sourceCircuitStates.value = Object.fromEntries(
      (response.data?.sources || [])
        .filter((source) => !!source.id)
        .map((source) => [source.id!, source.health?.circuitState || "closed"]),
    );
  } catch (error: any) {
    sourceCircuitStates.value = {};
    const code = error?.statusCode || error?.response?.status;
    if ([401, 403].includes(code)) {
      adminAuthenticated.value = false;
      adminLocked.value = true;
      return;
    }
    storageError.value = apiErrorMessage(error);
  }
}

let disposed = false;
let activeController: AbortController | undefined;
async function testSource(source: SourceDefinition) {
  if (runningId.value) return;
  if (!keyword.value.trim()) {
    notify("请输入测试关键词。");
    return;
  }
  runningId.value = source.id;
  activeController = new AbortController();
  const timer = setTimeout(() => activeController?.abort(), 16000);
  try {
    const result = await apiFetch<SourceProbe>("/api/sources/probe", {
      method: "POST",
      body: { sourceId: source.id, kw: keyword.value.trim() },
      signal: activeController.signal,
    });
    if (disposed) return;
    reports.value[source.id] = result;
    notify(`${source.name}：${result.message}`);
  } catch (error: any) {
    if (!disposed) {
      const code = error?.statusCode || error?.response?.status;
      if ([401, 403].includes(code)) {
        adminAuthenticated.value = false;
        adminLocked.value = true;
      }
      notify(
        code === 401
          ? "请先登录管理员账号。"
          : code === 403
            ? "当前账号没有管理员权限。"
            : `管理后台请求未完成：${error?.data?.statusMessage || error.message}。未将其记为来源异常。`,
      );
    }
  } finally {
    clearTimeout(timer);
    runningId.value = "";
    activeController = undefined;
  }
}
async function requestDeleteSource(source: SourceDefinition) {
  if (runningId.value || sourceToggleId.value) {
    notify("请等待当前来源操作完成后再删除。");
    return;
  }
  if (
    !(await confirmAction(
      `确定删除「${source.name}」吗？删除后下一次请求立即停止加载。`,
    ))
  )
    return;
  try {
    await apiFetch(`/api/settings/sources/${encodeURIComponent(source.id)}`, {
      method: "DELETE",
      body: { confirmation: source.id, actor: "admin-console" },
    });
    delete reports.value[source.id];
    detailDrawerOpen.value = false;
    debugDialogOpen.value = false;
    await Promise.all([loadSourceCatalog(), loadSourceHealth()]);
    notify("来源已删除，下一次请求立即生效。");
  } catch (error: any) {
    notify(apiErrorMessage(error));
  }
}
onBeforeUnmount(() => {
  disposed = true;
  activeController?.abort();
  clearTimeout(noticeTimer);
});
</script>
