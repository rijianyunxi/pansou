<template>
  <div class="monitor-panel">
    <div v-if="loadError" class="notice" role="alert">
      <ConsoleIcon name="info" />{{ loadError }}
    </div>

    <section class="metric-grid" aria-label="运行状态概览">
      <article class="metric-card">
        <div class="metric-label">管理资源源<ConsoleIcon name="grid" /></div>
        <div class="metric-value">
          {{ summary.total }}<span>个</span>
          <small class="metric-pill">资源源总数 {{ summary.total }}</small>
        </div>
        <p>已纳入管理的资源源</p>
      </article>
      <article class="metric-card">
        <div class="metric-label">正常<ConsoleIcon name="check" /></div>
        <div class="metric-value green">
          {{ summary.healthy }}<span>个</span>
          <small class="metric-pill">正常资源源 {{ summary.healthy }}</small>
        </div>
        <p><span class="status-dot warning"></span>另有需关注 {{ summary.warning }} 个</p>
      </article>
      <article class="metric-card">
        <div class="metric-label">异常<ConsoleIcon name="activity" /></div>
        <div class="metric-value">
          {{ summary.error }}<span>个</span>
          <small class="metric-pill">异常资源源 {{ summary.error }}</small>
        </div>
        <p><span class="status-dot error"></span>最近检查存在失败</p>
      </article>
      <article class="metric-card">
        <div class="metric-label">已关闭<ConsoleIcon name="sliders" /></div>
        <div class="metric-value">
          {{ summary.inactive }}<span>个</span>
          <small class="metric-pill">关闭资源源 {{ summary.inactive }}</small>
        </div>
        <p><span class="status-dot warning"></span>已移除 {{ summary.trashed }} 个，可在回收站恢复</p>
      </article>
    </section>

    <section class="sources-panel">
      <header class="monitor-header">
        <div class="monitor-heading-copy">
          <div class="monitor-title-row">
            <h2>运行状态 <span>{{ filteredRows.length }}<small v-if="filteredRows.length !== rows.length"> / {{ rows.length }}</small></span></h2>
            <span v-if="generatedAtLabel" class="monitor-last-sync">
              <span class="status-dot available"></span>最近同步 {{ generatedAtLabel }}
            </span>
          </div>
        </div>
      </header>
      <div class="source-toolbar">
        <div class="filter-tabs" aria-label="按资源源或状态筛选">
          <button
            v-for="option in FILTERS"
            :key="option.value"
            type="button"
            :class="{ active: filter === option.value }"
            @click="filter = option.value"
          >
            {{ option.label }}
          </button>
        </div>
        <label class="source-search">
          <ConsoleIcon name="search" :size="16" /><input
            v-model="search"
            type="search"
            aria-label="搜索资源源名称、ID 或错误信息"
            placeholder="搜索资源源名称、ID 或错误信息…"
          />
        </label>
        <div class="monitor-heading-actions">
          <div class="refresh-control" :class="{ active: autoRefresh }">
            <span class="refresh-control-icon" aria-hidden="true">
              <ConsoleIcon name="activity" :size="15" />
            </span>
            <span class="refresh-control-copy">
              <strong>{{ autoRefresh ? "自动更新" : "手动更新" }}</strong>
              <span>{{ autoRefresh ? `每 30 秒 · ${loading ? "正在同步…" : `下次更新 ${nextRefreshIn} 秒后`}` : "已关闭 · 仅点击按钮更新" }}</span>
            </span>
            <button
              class="toggle"
              :class="{ on: autoRefresh }"
              type="button"
              role="switch"
              :aria-checked="autoRefresh"
              :aria-label="autoRefresh ? '关闭自动更新' : '开启自动更新'"
              @click="autoRefresh = !autoRefresh"
            ><span></span></button>
          </div>
          <div class="monitor-settings-control">
          <button
            class="button secondary monitor-settings-button"
            type="button"
            :aria-expanded="sourceSettingsOpen"
            @click="openSourceSettings"
          >
            <ConsoleIcon name="sliders" :size="15" />
            <span>资源源设置</span>
          </button>
      <dialog
        v-if="sourceSettingsOpen"
        ref="sourceSettingsDialog"
        class="source-settings-dialog"
        aria-labelledby="monitor-search-settings-title"
        @close="sourceSettingsOpen = false"
        @click="onSourceSettingsBackdrop"
      >
      <section class="source-settings-panel">
        <header class="monitor-settings-header">
          <div>
            <h3 id="monitor-search-settings-title">资源源设置</h3>
            <p>勾选即参与搜索，取消勾选即可移出搜索范围。</p>
          </div>
          <span v-if="settingsLoading" class="tiny-muted">正在读取…</span>
          <button class="icon-button" type="button" aria-label="关闭资源源设置" @click="sourceSettingsDialog?.close()">
            <ConsoleIcon name="close" :size="16" />
          </button>
        </header>
        <div class="monitor-settings-content">
          <div class="section-label settings-source-heading">
            <div class="settings-source-heading-copy">
              搜索资源源 <span class="source-scope-tag">勾选即生效</span>
            </div>
            <div class="source-selection-actions" aria-label="批量选择来源">
              <button
                type="button"
                class="source-selection-button"
                :disabled="settingsSaving || settingsLoading || !sourceOptions.length"
                @click="selectAllSources"
              >全选</button>
              <button
                type="button"
                class="source-selection-button muted"
                :disabled="settingsSaving || settingsLoading || !settingsDraft.sources.length"
                @click="clearAllSources"
              >全不选</button>
            </div>
          </div>
          <div class="settings-source-grid">
            <label
              v-for="row in sourceOptions"
              :key="row.key"
              class="settings-source-item"
              :class="{ 'is-selected': settingsDraft.sources.includes(sourceSelectionKey(row)) }"
            >
              <input
                type="checkbox"
                :value="sourceSelectionKey(row)"
                v-model="settingsDraft.sources"
                :disabled="settingsSaving || settingsLoading" />
              <span class="settings-source-name">{{ row.name }}</span>
              <small class="source-id-tag">{{ row.id }}</small>
            </label>
            <p v-if="!sourceOptions.length" class="field-hint settings-source-empty">暂无可用来源。</p>
          </div>
          <p class="field-hint">只搜索已勾选的来源；取消勾选后，该来源会从搜索范围移除。</p>

          <div class="mapping-actions">
            <button
              class="button primary"
              :disabled="settingsSaving || settingsLoading"
              type="button"
              @click="saveSearchSettingsUi"
            >
              <span v-if="settingsSaving" class="spinner"></span>
              <ConsoleIcon v-else name="check" :size="15" />保存配置
            </button>
            <span v-if="settingsError" class="form-error">{{ settingsError }}</span>
          </div>
        </div>
      </section>
      </dialog>
          </div>
          <button class="button primary monitor-refresh-button" :disabled="loading" @click="loadMonitor()">
            <span v-if="loading" class="spinner"></span>
            <ConsoleIcon v-else name="refresh" :size="15" />
            <span>{{ loading ? "同步中…" : "立即刷新" }}</span>
          </button>
        </div>
      </div>

      <div class="monitor-card-grid" role="list" aria-label="正常状态列表">
        <article
          v-for="row in filteredRows"
          :key="row.key"
          class="monitor-card"
          :class="{ 'disabled-card': row.state === 'disabled' || row.state === 'trashed' }"
          role="listitem"
        >
          <header class="monitor-card-header">
            <div class="monitor-card-identity">
              <span class="card-checkbox" aria-hidden="true"></span>
              <div class="source-text">
                <div class="monitor-card-name">
                  <span class="monitor-kind-tag">资源源</span>
                  <strong>{{ row.name }}</strong>
                </div>
                <div class="monitor-card-id" :title="row.id">{{ row.detail || row.id }}</div>
              </div>
            </div>
            <span class="state-badge monitor-status" :class="STATE_TONES[row.state]">
              <span class="status-dot" :class="STATE_TONES[row.state]"></span>{{ STATE_LABELS[row.state] }}
            </span>
          </header>

          <section class="monitor-health-block" aria-label="最近 100 次正常统计">
            <div class="monitor-health-heading">
              <span>正常状态</span>
              <span class="monitor-health-counts">
                <strong class="success-text">成功 {{ row.health.successCount }}</strong>
                <strong class="failure-text">失败 {{ row.health.failureCount }}</strong>
              </span>
            </div>
            <div
              class="monitor-health-strip"
              role="img"
              :aria-label="`最近 100 次：成功 ${row.health.successCount} 次，失败 ${row.health.failureCount} 次，成功率 ${healthPercent(row)}`"
            >
              <span
                v-for="(sample, index) in row.health.segments"
                :key="`${row.key}-health-${index}`"
                class="health-segment"
                :class="`is-${sample}`"
                :title="healthSampleTitle(sample, index)"
              ></span>
            </div>
            <div class="monitor-health-footer">
              <span>最近 100 次</span>
              <strong>{{ healthPercent(row) }}</strong>
            </div>
          </section>

          <div class="monitor-card-meta">
            <span><ConsoleIcon name="clock" :size="14" />{{ checkedAtText(row) }}</span>
            <span v-if="row.version">版本 {{ row.version }}</span>
            <span v-else>{{ row.typeLabel }}</span>
          </div>

          <footer class="monitor-card-actions">
            <button
              class="monitor-action-label"
              type="button"
              @click="emit('test-source', row.id)"
            ><ConsoleIcon name="grid" :size="16" />{{ "测试" }}</button>
            <button
              class="monitor-icon-action"
              type="button"
              :aria-label="`查看 ${row.name} 最近失败记录`"
              :title="`查看最近 10 条失败记录（当前 ${row.recentFailures.length} 条）`"
              @click="openFailureLog(row)"
            >
              <ConsoleIcon name="activity" :size="18" />
            </button>
            <button
              class="monitor-icon-action danger"
              type="button"
              :aria-label="`删除 ${row.name}`"
              title="删除"
              :disabled="busyKey === row.key || deleteBusy"
              @click="requestDeleteSource(row)"
            ><ConsoleIcon name="trash" :size="17" /></button>
            <span class="monitor-enable-label">开启</span>
            <button
              class="toggle monitor-card-toggle"
              :class="{ on: row.enabled && !row.trashed }"
              type="button"
              role="switch"
              :aria-checked="row.enabled && !row.trashed"
              :aria-label="`${row.enabled && !row.trashed ? '关闭' : '开启'} ${row.name}`"
              :disabled="busyKey === row.key || deleteBusy"
              @click="toggleSource(row)"
            ><span></span></button>
          </footer>
        </article>
      </div>
      <footer class="table-footer">
        <span><span class="status-dot neutral"></span>{{ filteredRows.length }} / {{ rows.length }} 个资源源</span>
        <span>数据来自服务端正常快照；操作会立即同步资源源配置状态</span>
      </footer>
    </section>

    <div v-if="failureLogTarget" class="modal-backdrop confirmation-backdrop" @click.self="closeFailureLog">
      <section
        class="failure-log-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="monitor-failure-log-title"
      >
        <header class="failure-log-header">
          <div>
            <span class="eyebrow">RESOURCE SOURCE HEALTH</span>
            <h2 id="monitor-failure-log-title">最近失败记录</h2>
            <p>{{ failureLogTarget.name }} · 最多显示最近 10 条</p>
          </div>
          <button class="icon-button" type="button" aria-label="关闭失败记录" @click="closeFailureLog">
            <ConsoleIcon name="close" :size="16" />
          </button>
        </header>
        <div v-if="!failureLogTarget.recentFailures.length" class="failure-log-empty">
          <ConsoleIcon name="check" :size="24" />
          <strong>暂无失败记录</strong>
          <p>当前资源源还没有可展示的失败请求。</p>
        </div>
        <ol v-else class="failure-log-list">
          <li v-for="(record, index) in failureLogTarget.recentFailures" :key="`${failureLogTarget.key}-failure-${record.at}-${index}`">
            <div class="failure-log-item-head">
              <strong>#{{ index + 1 }}</strong>
              <span>{{ failureRecordTime(record) }}</span>
              <span v-if="record.responseTimeMs !== null && record.responseTimeMs !== undefined">{{ record.responseTimeMs }} ms</span>
            </div>
            <div class="failure-log-item-category">{{ record.errorCategory || "unknown_error" }}</div>
            <p>{{ failureRecordMessage(record) }}</p>
          </li>
        </ol>
        <footer class="failure-log-footer">
          <span>按最新失败时间倒序</span>
          <button class="button secondary" type="button" @click="closeFailureLog">关闭</button>
        </footer>
      </section>
    </div>

    <div v-if="sourceDeleteTarget" class="modal-backdrop confirmation-backdrop" @click.self="closeSourceDelete">
      <form
        class="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="monitor-delete-source-title"
        @submit.prevent="confirmDeleteSource"
      >
        <span class="confirm-icon archive"><ConsoleIcon name="trash" :size="22" /></span>
        <h2 id="monitor-delete-source-title">
          删除此资源源？
        </h2>
        <p>
          <strong>{{ sourceDeleteTarget.name }}</strong>
          的资源源配置将被删除，下一次搜索立即停止加载。
        </p>
          <label for="monitor-delete-confirmation">输入资源源 ID <code>{{ sourceDeleteTarget.id }}</code> 以确认</label>
          <input
            id="monitor-delete-confirmation"
            v-model="sourceDeleteConfirm"
            autocomplete="off"
            spellcheck="false"
            :placeholder="sourceDeleteTarget.id"
          />

        <div class="confirm-actions">
          <button class="button secondary" type="button" @click="closeSourceDelete">取消</button>
          <button
            class="button destructive"
            type="submit"
            :disabled="deleteBusy || sourceDeleteConfirm !== sourceDeleteTarget.id"
          >
            <span v-if="deleteBusy" class="spinner"></span>
            确认删除
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
import ConsoleIcon from "../sources/ConsoleIcon.vue";
import {
  STATE_LABELS,
  STATE_TONES,
  buildMonitorRows,
  checkedAtText,
  extractMonitorData,
  failureRecordMessage,
  failureRecordTime,
  filterRows,
  summarizeRows,
  withRowRemoved,
  withRowRestored,
  withSourceEnabled,
  type MonitorFilter,
  type MonitorRow,
} from "./monitorView";

const emit = defineEmits<{
  (event: "unauthorized"): void;
  (event: "test-source", id: string): void;
}>();

const FILTERS: Array<{ label: string; value: MonitorFilter }> = [
  { label: "全部", value: "all" },
  { label: "资源源", value: "source" },
  { label: "异常", value: "error" },
  { label: "已关闭", value: "inactive" },
];
const AUTO_REFRESH_MS = 30_000;
const AUTO_REFRESH_SECONDS = AUTO_REFRESH_MS / 1_000;

interface SearchSettingsState {
  sources: string[] | null;
  channels: string[] | null;
  trashedSources: string[];
}

const rows = ref<MonitorRow[]>([]);
const generatedAt = ref("");
const loading = ref(false);
const loaded = ref(false);
const loadError = ref("");
const filter = ref<MonitorFilter>("all");
const search = ref("");
const busyKey = ref("");
const deleteBusy = ref(false);
const notice = ref("");
const failureLogTarget = ref<MonitorRow | null>(null);
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

const summary = computed(() => summarizeRows(rows.value));
const filteredRows = computed(() => filterRows(rows.value, filter.value, search.value));
const generatedAtLabel = computed(() => {
  const ms = Date.parse(generatedAt.value);
  return Number.isFinite(ms)
    ? new Date(ms).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "";
});

const sourceDeleteTarget = ref<MonitorRow | null>(null);
const sourceDeleteConfirm = ref("");

const autoRefresh = ref(true);
const sourceSettingsOpen = ref(false);
const sourceSettingsDialog = ref<HTMLDialogElement>();
const nextRefreshIn = ref(AUTO_REFRESH_SECONDS);
let autoTimer: ReturnType<typeof setInterval> | undefined;
let countdownTimer: ReturnType<typeof setInterval> | undefined;

const searchSettings = ref<SearchSettingsState>({
  sources: null,
  channels: null,
  trashedSources: [],
});
const settingsLoading = ref(false);
const settingsSaving = ref(false);
const settingsError = ref("");
const settingsDraft = ref<{
  sources: string[];
}>({ sources: [] });
const sourceOptions = computed(() =>
  rows.value
    .filter((row) => !row.trashed)
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
);

function sourceSelectionKey(row: MonitorRow): string {
  return `source:${row.id}`;
}

function selectAllSources() {
  settingsDraft.value.sources = sourceOptions.value.map(sourceSelectionKey);
}

function clearAllSources() {
  settingsDraft.value.sources = [];
}

function openSourceSettings() {
  sourceSettingsOpen.value = true;
  nextTick(() => {
    if (sourceSettingsDialog.value && !sourceSettingsDialog.value.open) {
      sourceSettingsDialog.value.showModal();
    }
  });
}

function onSourceSettingsBackdrop(event: MouseEvent) {
  if (event.target === sourceSettingsDialog.value) sourceSettingsDialog.value?.close();
}

function apiErrorMessage(error: any): string {
  const code = error?.statusCode || error?.response?.status;
  if (code === 401) return "请先登录管理员账号。";
  if (code === 403) return "当前账号没有管理员权限。";
  if (code === 429) return "尝试次数过多，请稍后再试。";
  return error?.data?.statusMessage || error?.message || "服务端操作失败。";
}

function notify(message: string) {
  notice.value = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = ""), 4000);
}

function resetRefreshCountdown() {
  nextRefreshIn.value = AUTO_REFRESH_SECONDS;
}

async function loadMonitor(options: { silent?: boolean } = {}) {
  if (!options.silent) {
    loading.value = true;
    resetRefreshCountdown();
  }
  try {
    const response = await $fetch<unknown>("/api/monitor", { cache: "no-store" });
    const payload = response && typeof response === "object"
      ? (response as { code?: unknown; message?: unknown })
      : {};
    if (typeof payload.code === "number" && payload.code !== 0) {
      throw new Error(typeof payload.message === "string" ? payload.message : "监控接口返回失败");
    }
    const data = extractMonitorData(response);
    rows.value = buildMonitorRows(data);
    generatedAt.value = data.generatedAt ?? "";
    loadError.value = "";
  } catch (error: any) {
    const code = error?.statusCode || error?.response?.status;
    if (code === 401) {
      emit("unauthorized");
      return;
    }
    // 保留旧数据只提示错误，避免后端未就绪时整页空白。
    loadError.value = `监控数据加载失败：${apiErrorMessage(error)}`;
  } finally {
    loaded.value = true;
    if (!options.silent) loading.value = false;
    if (autoRefresh.value) resetRefreshCountdown();
  }
}

async function loadSearchSettings() {
  settingsLoading.value = true;
  try {
    const response = await $fetch<{ data?: SearchSettingsState }>(
      "/api/settings/search",
      { cache: "no-store" },
    );
    const data: Partial<SearchSettingsState> = response.data || {};
    searchSettings.value = {
      sources: data.sources ?? null,
      channels: data.channels ?? null,
      trashedSources: data.trashedSources ?? [],
    };
    const enabledRows = sourceOptions.value.filter((row) => row.enabled && !row.trashed);
    const selectedSources = [
      ...(searchSettings.value.sources === null
        ? enabledRows.filter((row) => !row.origin).map(sourceSelectionKey)
        : (searchSettings.value.sources || []).map((id) => `source:${id}`)),
      ...(searchSettings.value.channels === null
        ? enabledRows.filter((row) => !!row.origin).map(sourceSelectionKey)
        : (searchSettings.value.channels || []).map((id) => `source:${id}`)),
    ];
    settingsDraft.value = { sources: selectedSources };
    settingsError.value = "";
  } catch (error: any) {
    settingsError.value = apiErrorMessage(error);
    if ((error?.statusCode || error?.response?.status) === 401) emit("unauthorized");
  } finally {
    settingsLoading.value = false;
  }
}

async function setSourceEnabled(row: MonitorRow, enabled: boolean) {
  const response = await $fetch<{ code?: number; message?: string }>(
    `/api/settings/sources/${encodeURIComponent(row.id)}/${enabled ? "enable" : "disable"}`,
    { method: "POST" },
  );
  if ((response.code ?? 0) !== 0) throw new Error(response.message || "操作未被接受");
}

async function saveSearchSettingsUi() {
  if (settingsSaving.value || settingsLoading.value) return;
  settingsSaving.value = true;
  settingsError.value = "";
  try {
    const selectedKeys = new Set(settingsDraft.value.sources);
    const selectedRows = sourceOptions.value.filter((row) => selectedKeys.has(sourceSelectionKey(row)));
    const desiredChannels = selectedRows.filter((row) => !!row.origin).map((row) => row.id);
    const desiredSources = selectedRows.filter((row) => !row.origin).map((row) => row.id);
    for (const row of sourceOptions.value) {
      const shouldBeEnabled = selectedKeys.has(sourceSelectionKey(row));
      if (row.enabled !== shouldBeEnabled) await setSourceEnabled(row, shouldBeEnabled);
    }

    const response = await $fetch<{ data?: SearchSettingsState }>(
      "/api/settings/search",
      {
        method: "PUT",
        body: {
          sources: desiredSources,
          channels: desiredChannels,
        },
      },
    );
    const data: Partial<SearchSettingsState> = response.data || {};
    searchSettings.value = {
      sources: data.sources ?? null,
      channels: data.channels ?? null,
      trashedSources: data.trashedSources ?? [],
    };
    settingsDraft.value.sources = [
      ...(searchSettings.value.sources || []).map((id) => `source:${id}`),
      ...(searchSettings.value.channels || []).map((id) => `source:${id}`),
    ];
    await loadMonitor({ silent: true });
    notify("搜索资源源设置已保存。");
    sourceSettingsDialog.value?.close();
  } catch (error: any) {
    settingsError.value = apiErrorMessage(error);
    if ((error?.statusCode || error?.response?.status) === 401) emit("unauthorized");
    else notify(`保存失败：${apiErrorMessage(error)}`);
  } finally {
    settingsSaving.value = false;
  }
}

function stopAutoRefresh() {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = undefined;
  }
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = undefined;
  }
}

function syncAutoRefresh() {
  if (!import.meta.client) return;
  stopAutoRefresh();
  resetRefreshCountdown();
  if (autoRefresh.value) {
    countdownTimer = setInterval(() => {
      if (loading.value || document.visibilityState === "hidden") return;
      nextRefreshIn.value = Math.max(1, nextRefreshIn.value - 1);
    }, 1_000);
    autoTimer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      resetRefreshCountdown();
      void loadMonitor({ silent: true });
    }, AUTO_REFRESH_MS);
  }
}

watch(autoRefresh, () => syncAutoRefresh());

/** 统一资源源启停：乐观更新 → 调用统一端点 → 重新拉取；失败回滚。 */
async function toggleSource(row: MonitorRow) {
  if (busyKey.value || deleteBusy.value) return;
  const next = !(row.enabled && !row.trashed);
  const snapshot = rows.value;
  busyKey.value = row.key;
  rows.value = next ? withRowRestored(rows.value, row.key) : withSourceEnabled(rows.value, row.id, false);
  try {
    await setSourceEnabled(row, next);
    const sources = new Set(settingsDraft.value.sources);
    const key = sourceSelectionKey(row);
    if (next) sources.add(key);
    else sources.delete(key);
    settingsDraft.value.sources = [...sources];
    notify(`${row.name} 已${next ? (row.trashed ? "恢复" : "开启") : "关闭"}。`);
    await loadMonitor({ silent: true });
  } catch (error: any) {
    rows.value = snapshot;
    if ((error?.statusCode || error?.response?.status) === 401) emit("unauthorized");
    else notify(`操作失败：${apiErrorMessage(error)}`);
  } finally {
    busyKey.value = "";
  }
}

function openFailureLog(row: MonitorRow) {
  failureLogTarget.value = row;
}

function closeFailureLog() {
  failureLogTarget.value = null;
}

function requestDeleteSource(row: MonitorRow) {
  if (busyKey.value || deleteBusy.value) return;
  sourceDeleteTarget.value = row;
  sourceDeleteConfirm.value = "";
}

function closeSourceDelete() {
  if (deleteBusy.value) return;
  sourceDeleteTarget.value = null;
  sourceDeleteConfirm.value = "";
}

async function confirmDeleteSource() {
  const target = sourceDeleteTarget.value;
  if (!target || deleteBusy.value || sourceDeleteConfirm.value !== target.id) return;
  deleteBusy.value = true;
  const snapshot = rows.value;
  try {
    await $fetch(`/api/settings/sources/${encodeURIComponent(target.id)}`, {
      method: "DELETE",
      body: { confirmation: target.id, actor: "monitor-console" },
    });
    rows.value = withRowRemoved(rows.value, target.key);
    sourceDeleteTarget.value = null;
    sourceDeleteConfirm.value = "";
    notify(`${target.name} 已移除。`);
    await loadMonitor({ silent: true });
  } catch (error: any) {
    rows.value = snapshot;
    if ((error?.statusCode || error?.response?.status) === 401) emit("unauthorized");
    else notify(`删除失败：${apiErrorMessage(error)}`);
  } finally {
    deleteBusy.value = false;
  }
}

function healthPercent(row: MonitorRow): string {
  return row.health.successRate === null ? "—" : `${Math.round(row.health.successRate * 10) / 10}%`;
}

function healthSampleTitle(sample: MonitorRow["health"]["samples"][number], index: number): string {
  const position = index + 1;
  if (sample === "success") return `第 ${position} 组（5 次）：成功`;
  if (sample === "failure") return `第 ${position} 组（5 次）：包含失败`;
  return `第 ${position} 组（5 次）：暂无记录`;
}

onMounted(async () => {
  if (!loaded.value) await loadMonitor();
  await loadSearchSettings();
  syncAutoRefresh();
});

onBeforeUnmount(() => {
  stopAutoRefresh();
  clearTimeout(noticeTimer);
});
</script>

<style scoped>
.monitor-panel {
  display: grid;
  gap: 18px;
  min-width: 0;
}
.monitor-heading-copy {
  min-width: 0;
}
.monitor-title-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.monitor-last-sync {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: #7b8790;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.monitor-heading-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  flex-shrink: 0;
}
.monitor-settings-control {
  position: relative;
  flex: 0 0 auto;
}
.source-settings-dialog {
  width: min(680px, calc(100vw - 48px));
  max-width: none;
  max-height: min(88dvh, 760px);
  overflow: hidden;
  padding: 0;
  border: 1px solid #dfe7f1;
  border-radius: 18px;
  background: #fff;
  color: var(--ink);
  box-shadow: 0 34px 110px rgba(15, 23, 42, 0.28);
}
.source-settings-dialog::backdrop {
  background: rgba(17, 24, 39, 0.46);
  backdrop-filter: blur(3px);
}
.source-settings-panel {
  max-height: min(88dvh, 760px);
  overflow-y: auto;
}
.monitor-settings-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  padding: 18px 20px 10px;
  border-bottom: 1px solid #edf1f6;
}
.monitor-settings-header h3 {
  margin: 0;
  color: #111827;
  font-size: 14px;
  font-weight: 700;
}
.monitor-settings-header p {
  margin: 5px 0 0;
  color: #7b8790;
  font-size: 11px;
  line-height: 1.6;
}
.monitor-settings-content {
  padding: 16px 20px 20px;
}
.section-label {
  display: flex;
  align-items: center;
  gap: 8px;
}
.settings-source-heading {
  justify-content: space-between;
  gap: 14px;
}
.settings-source-heading-copy {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.source-selection-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}
.source-selection-button {
  min-height: 28px;
  padding: 0 9px;
  border: 1px solid #cfe9dc;
  border-radius: 8px;
  background: #f0faf5;
  color: #16845a;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
}
.source-selection-button:hover:not(:disabled) {
  border-color: #8fc9aa;
  background: #e5f7ed;
}
.source-selection-button.muted {
  border-color: #e2e7e4;
  background: #fff;
  color: #718078;
}
.source-selection-button.muted:hover:not(:disabled) {
  border-color: #c5cfca;
  background: #f7faf8;
}
.source-selection-button:disabled {
  cursor: not-allowed;
  opacity: .45;
}
.source-scope-tag {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  padding: 0 8px;
  border: 1px solid #cfe9dc;
  border-radius: 999px;
  background: #f0faf5;
  color: #16845a;
  font-size: 10px;
  font-weight: 750;
  letter-spacing: .02em;
}
.settings-source-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 9px;
  margin-top: 12px;
}
.settings-source-item {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  min-height: 44px;
  padding: 8px 10px;
  border: 1px solid #e4ebe7;
  border-radius: 12px;
  background: #fbfdfc;
  color: #34413b;
  cursor: pointer;
  transition: border-color .16s ease, background-color .16s ease, box-shadow .16s ease;
}
.settings-source-item:hover {
  border-color: #b9dcca;
  background: #f8fcfa;
}
.settings-source-item.is-selected {
  border-color: #a9d8bf;
  background: #f1faf5;
  box-shadow: inset 3px 0 0 #27a66b;
}
.settings-source-item input {
  width: 17px;
  height: 17px;
  flex: 0 0 17px;
  margin: 0;
  accent-color: #168b5b;
}
.settings-source-name {
  min-width: 0;
  overflow: hidden;
  color: #27352e;
  font-size: 13px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.source-id-tag {
  flex: 0 1 auto;
  max-width: 45%;
  overflow: hidden;
  padding: 3px 7px;
  border: 1px solid #dce9e1;
  border-radius: 999px;
  background: #eef5f1;
  color: #6e8478;
  font: 10px ui-monospace, SFMono-Regular, Consolas, monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.settings-source-empty {
  grid-column: 1 / -1;
}
.refresh-control {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 44px;
  padding: 6px 9px 6px 8px;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  background: #fafafa;
  transition: border-color .18s ease, background-color .18s ease, box-shadow .18s ease;
}
.refresh-control.active {
  border-color: #bfdbfe;
  background: #f8fbff;
  box-shadow: 0 2px 8px rgba(37, 99, 235, .06);
}
.refresh-control-icon {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  color: #7b8790;
  background: #eef1f3;
}
.refresh-control.active .refresh-control-icon {
  color: #2563eb;
  background: #dbeafe;
}
.refresh-control-copy {
  display: grid;
  gap: 1px;
  min-width: 122px;
}
.refresh-control-copy strong {
  color: #374151;
  font-size: 11px;
  font-weight: 650;
}
.refresh-control-copy span {
  color: #8a969f;
  font-size: 9px;
  white-space: nowrap;
}
.monitor-refresh-button {
  min-height: 44px;
  gap: 7px;
  padding-inline: 14px;
  white-space: nowrap;
}
.monitor-title-row h2 > span small {
  color: #9aa39e;
  font-size: 9px;
  font-weight: 400;
}
.monitor-card-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  padding: 22px 30px 26px;
}
.monitor-card {
  min-width: 0;
  padding: 22px 20px 18px;
  border: 1px solid #e1e7e4;
  border-radius: 18px;
  background: #fff;
  box-shadow: 0 5px 16px rgba(25, 48, 38, .035);
  transition: border-color .18s ease, box-shadow .18s ease, transform .18s ease;
}
.monitor-card:hover {
  border-color: #b7d9c9;
  box-shadow: 0 10px 24px rgba(25, 48, 38, .08);
  transform: translateY(-1px);
}
.monitor-card.disabled-card { opacity: .68; }
.monitor-card-header, .monitor-card-identity, .monitor-card-name, .monitor-health-heading, .monitor-health-counts, .monitor-card-meta, .monitor-card-actions {
  display: flex;
  align-items: center;
}
.monitor-card-header { justify-content: space-between; gap: 12px; }
.monitor-card-identity { min-width: 0; gap: 12px; }
.card-checkbox {
  width: 23px; height: 23px; flex: 0 0 23px; border: 2px solid #dfe4e2; border-radius: 8px;
  background: #fff;
}
.monitor-card-avatar { width: 45px; height: 45px; border-radius: 13px; font-size: 15px; }
.monitor-card-name { gap: 9px; min-width: 0; }
.monitor-card-name strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #2c2d2f; font-size: 16px; font-weight: 700; }
.monitor-kind-tag { padding: 5px 10px; border-radius: 9px; background: #e9e7ff; color: #4542d6; font-size: 11px; font-weight: 750; letter-spacing: .08em; }
.monitor-card-id { margin-top: 7px; overflow: hidden; color: #a2a29d; font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; }
.monitor-status { flex: 0 0 auto; padding: 6px 12px; border-radius: 999px; font-size: 12px; }
.monitor-health-block { margin-top: 26px; }
.monitor-health-heading { justify-content: space-between; gap: 8px; color: #989b98; font-size: 13px; font-weight: 650; }
.monitor-health-counts { gap: 12px; font-size: 15px; }
.success-text { color: #0daf73; }
.failure-text { color: #cf5847; }
.monitor-health-strip { display: grid; grid-template-columns: repeat(20, minmax(0, 1fr)); gap: 4px; margin-top: 16px; }
.health-segment { height: 14px; min-width: 0; border-radius: 3px; background: #eceeec; }
.health-segment.is-success { background: #19bd68; }
.health-segment.is-failure { background: #e56b5e; }
.monitor-health-footer { display: flex; justify-content: space-between; margin-top: 9px; color: #a2a29d; font-size: 12px; }
.monitor-health-footer strong { color: #0daf73; font-size: 18px; font-weight: 700; }
.monitor-card-meta { gap: 14px; margin-top: 22px; padding-top: 16px; border-top: 1px solid #edf0ee; color: #aaa9a3; font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; }
.monitor-card-meta span { display: inline-flex; align-items: center; gap: 5px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.failure-log-dialog {
  width: min(620px, calc(100vw - 32px));
  max-height: min(78dvh, 720px);
  overflow: hidden;
  padding: 0;
  border: 1px solid #dfe7f1;
  border-radius: 18px;
  background: #fff;
  color: var(--ink);
  box-shadow: 0 34px 110px rgba(15, 23, 42, .28);
}
.failure-log-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  padding: 20px 22px 15px;
  border-bottom: 1px solid #edf1f6;
}
.failure-log-header h2 { margin: 4px 0 0; color: #111827; font-size: 18px; }
.failure-log-header p { margin: 6px 0 0; color: #7b8790; font-size: 12px; }
.failure-log-list {
  display: grid;
  gap: 10px;
  max-height: min(52dvh, 470px);
  overflow-y: auto;
  margin: 0;
  padding: 16px 22px;
  list-style: none;
}
.failure-log-list li {
  padding: 12px 14px;
  border: 1px solid #edf0f2;
  border-radius: 12px;
  background: #fbfcfc;
}
.failure-log-item-head {
  display: flex;
  align-items: center;
  gap: 10px;
  color: #7b8790;
  font: 11px ui-monospace, SFMono-Regular, Consolas, monospace;
}
.failure-log-item-head strong { color: #c95749; font-size: 12px; }
.failure-log-item-head span:last-child { margin-left: auto; }
.failure-log-item-category {
  display: inline-flex;
  margin-top: 8px;
  padding: 3px 7px;
  border-radius: 6px;
  background: #fff0ed;
  color: #c95749;
  font: 10px ui-monospace, SFMono-Regular, Consolas, monospace;
}
.failure-log-list li p { margin: 8px 0 0; color: #414c53; font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.failure-log-empty { padding: 40px 22px 34px; text-align: center; color: #0c9a65; }
.failure-log-empty strong { display: block; margin-top: 10px; color: #34413b; font-size: 14px; }
.failure-log-empty p { margin: 6px 0 0; color: #8c9891; font-size: 12px; }
.failure-log-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 22px 16px;
  border-top: 1px solid #edf1f6;
  color: #9aa39e;
  font-size: 11px;
}
.monitor-card-actions { gap: 8px; margin-top: 16px; }
.monitor-action-label, .monitor-icon-action { display: inline-flex; align-items: center; justify-content: center; border: 1px solid #e0e4e2; background: #fff; color: #545957; }
.monitor-action-label { gap: 8px; min-height: 42px; padding: 0 17px; border-radius: 13px; font-size: 15px; font-weight: 700; }
.monitor-icon-action { width: 42px; height: 42px; border-radius: 13px; }
.monitor-action-label:hover:not(:disabled), .monitor-icon-action:hover:not(:disabled) { border-color: #b9d5c6; background: #f6fbf8; color: #12784f; }
.monitor-icon-action.danger { color: #d35d4f; border-color: #f0c9c2; }
.monitor-enable-label { margin-left: auto; color: #aaa9a3; font-size: 13px; }
.monitor-card-toggle { flex: 0 0 auto; }
@media (max-width: 980px) { .monitor-card-grid { grid-template-columns: 1fr; } }
@media (max-width: 700px) {
  .source-settings-dialog {
    width: calc(100vw - 28px);
  }
  .settings-source-grid { grid-template-columns: 1fr; }
}
@media (max-width: 560px) {
  .monitor-card-grid { padding: 16px 14px 20px; }
  .monitor-card { padding: 18px 15px 15px; }
  .monitor-card-header { align-items: flex-start; flex-direction: column; }
  .monitor-status { align-self: flex-end; margin-top: -4px; }
  .monitor-health-strip { gap: 3px; }
  .monitor-action-label { padding-inline: 12px; }
  .monitor-icon-action { width: 38px; height: 38px; }
}
.monitor-table th,
.monitor-table td {
  white-space: nowrap;
}
.monitor-table td {
  height: auto;
  padding-block: 10px;
}
.monitor-table .monitor-actions {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}
.monitor-table .monitor-actions .button.small {
  min-height: 30px;
  padding: 6px 10px;
  white-space: nowrap;
}
.monitor-table .monitor-actions .text-button {
  white-space: nowrap;
  min-height: 30px;
  padding: 0 6px;
}
.monitor-table .action-column .button,
.monitor-table .action-column .text-button {
  margin-left: 0;
}
.monitor-metric {
  display: block;
  font:
    10px ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  color: #6b7280;
  white-space: nowrap;
}
.monitor-restore-hint {
  color: #b45309;
}
@media (prefers-reduced-motion: reduce) {
  .refresh-control { transition: none; }
}
@media (max-width: 860px) {
  .monitor-table .monitor-col-metrics,
  .monitor-table .monitor-col-checked {
    display: none;
  }
  .monitor-table .action-column .button,
  .monitor-table .action-column .text-button {
    margin-left: 0;
    margin-right: 6px;
  }
  .monitor-header {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 14px;
  }
  .monitor-heading-actions {
    width: 100%;
    justify-content: stretch;
  }
  .monitor-heading-actions .button {
    flex: 1;
    min-height: 42px;
  }
  .refresh-control {
    flex: 1;
    min-width: 0;
  }
  .refresh-control-copy {
    min-width: 0;
    flex: 1;
  }
}
@media (max-width: 480px) {
  .monitor-heading-actions {
    flex-direction: column;
    align-items: stretch;
  }
  .refresh-control,
 .monitor-refresh-button {
    width: 100%;
  }
  .refresh-control-copy span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
}
</style>
