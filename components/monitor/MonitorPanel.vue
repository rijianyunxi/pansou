<template>
  <div class="monitor-panel">
    <div v-if="loadError" class="notice" role="alert">
      <ConsoleIcon name="info" />{{ loadError }}
    </div>

    <section class="metric-grid" aria-label="监控概览">
      <article class="metric-card">
        <div class="metric-label">纳入监控<ConsoleIcon name="grid" /></div>
        <div class="metric-value">
          {{ summary.total }}<span>个</span>
          <small class="metric-pill">上游 {{ summary.upstreams.total }} · 频道 {{ summary.channels.total }}</small>
        </div>
        <p>已配置的上游与 TG 频道</p>
      </article>
      <article class="metric-card">
        <div class="metric-label">健康<ConsoleIcon name="check" /></div>
        <div class="metric-value green">
          {{ summary.healthy }}<span>个</span>
          <small class="metric-pill">上游 {{ summary.upstreams.healthy }} · 频道 {{ summary.channels.healthy }}</small>
        </div>
        <p><span class="status-dot warning"></span>另有待关注 {{ summary.warning }} 个</p>
      </article>
      <article class="metric-card">
        <div class="metric-label">异常<ConsoleIcon name="activity" /></div>
        <div class="metric-value">
          {{ summary.error }}<span>个</span>
          <small class="metric-pill">上游 {{ summary.upstreams.error }} · 频道 {{ summary.channels.error }}</small>
        </div>
        <p><span class="status-dot error"></span>最近检查有失败记录</p>
      </article>
      <article class="metric-card">
        <div class="metric-label">已停用<ConsoleIcon name="sliders" /></div>
        <div class="metric-value">
          {{ summary.inactive }}<span>个</span>
          <small class="metric-pill">上游 {{ summary.upstreams.inactive }} · 频道 {{ summary.channels.inactive }}</small>
        </div>
        <p><span class="status-dot warning"></span>已删除 {{ summary.trashed }} 个，可在垃圾箱 / 重新启用恢复</p>
      </article>
    </section>

    <section class="sources-panel">
      <header class="monitor-header">
        <div class="monitor-heading-copy">
          <div class="monitor-title-row">
            <h2>监控清单 <span>{{ filteredRows.length }}<small v-if="filteredRows.length !== rows.length"> / {{ rows.length }}</small></span></h2>
            <span v-if="generatedAtLabel" class="monitor-last-sync">
              <span class="status-dot available"></span>最近同步 {{ generatedAtLabel }}
            </span>
          </div>
          <p>查看上游和 TG 频道的当前状态，支持按类型、状态和关键词筛选</p>
        </div>
      </header>
      <div class="source-toolbar">
        <div class="filter-tabs" aria-label="按类型或状态筛选">
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
            aria-label="搜索名称、ID 或错误信息"
            placeholder="搜索监控对象..."
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
          <button class="button primary monitor-refresh-button" :disabled="loading" @click="loadMonitor()">
            <span v-if="loading" class="spinner"></span>
            <ConsoleIcon v-else name="refresh" :size="15" />
            <span>{{ loading ? "同步中…" : "立即刷新" }}</span>
          </button>
        </div>
      </div>
      <div class="table-scroll">
        <table class="source-table monitor-table">
          <thead>
            <tr>
              <th>对象</th>
              <th>类型</th>
              <th>状态</th>
              <th class="monitor-col-metrics">关键指标</th>
              <th class="monitor-col-checked">最近检查</th>
              <th class="action-column">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in filteredRows"
              :key="row.key"
              :class="{ 'disabled-row': row.state === 'disabled' || row.state === 'trashed' }"
            >
              <td>
                <div class="source-identity">
                  <span class="source-avatar monitor-avatar" :data-kind="row.kind">{{
                    row.kind === "channel" ? "T" : row.name.charAt(0).toUpperCase()
                  }}</span>
                  <div class="source-text">
                    <div class="source-name">
                      {{ row.name
                      }}<span v-if="row.version" class="method-tag">{{ row.version }}</span>
                    </div>
                    <div class="source-address" :title="row.detail || row.id">
                      {{ row.detail || row.id }}
                    </div>
                  </div>
                </div>
              </td>
              <td>
                <span class="state-badge">{{ row.typeLabel }}</span>
              </td>
              <td>
                <span class="state-badge" :class="STATE_TONES[row.state]">
                  <span class="status-dot" :class="STATE_TONES[row.state]"></span>{{ STATE_LABELS[row.state] }}
                </span>
              </td>
              <td class="monitor-col-metrics">
                <span v-for="metric in row.metrics" :key="metric" class="monitor-metric">{{ metric }}</span>
              </td>
              <td class="monitor-col-checked">
                <span class="latency">{{ checkedAtText(row) }}</span>
              </td>
              <td class="action-column">
                <div v-if="row.kind === 'upstream'" class="monitor-actions">
                  <template v-if="!row.trashed">
                    <button
                      class="button secondary small"
                      type="button"
                      :disabled="busyKey === row.key"
                      @click="toggleUpstream(row)"
                    >{{ row.enabled ? "停用" : "启用" }}</button>
                  </template>
                  <NuxtLink v-else to="/admin?view=sources" class="text-button monitor-restore-hint">
                    垃圾箱可恢复
                  </NuxtLink>
                  <button class="button secondary small" type="button" @click="emit('focus-upstream', row.id)">详情</button>
                  <button
                    v-if="row.upstreamKind === 'instructions'"
                    class="button danger-button small"
                    type="button"
                    :disabled="busyKey === row.key"
                    @click="requestDeleteUpstream(row)"
                  >删除</button>
                </div>
                <div v-else class="monitor-actions">
                  <button
                    class="button secondary small"
                    type="button"
                    :disabled="busyKey === row.key"
                    @click="toggleChannel(row)"
                  >{{ row.trashed || !row.enabled ? "启用" : "停用" }}</button>
                  <button class="button secondary small" type="button" @click="emit('debug-channel', row.id)">调试</button>
                  <button
                    class="button danger-button small"
                    type="button"
                    :disabled="busyKey === row.key"
                    @click="requestDeleteChannel(row)"
                  >删除</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="!filteredRows.length" class="empty-sources">
          <ConsoleIcon name="activity" :size="28" />
          <h3>{{ rows.length ? "没有匹配的对象" : "暂无监控数据" }}</h3>
          <p>
            {{
              rows.length
                ? "换一个关键词，或调整类型筛选。"
                : "后端 /api/monitor 尚未返回数据；接口就绪后这里会显示上游与频道的健康状态。"
            }}
          </p>
          <button
            v-if="rows.length"
            class="button secondary small"
            type="button"
            @click="resetFilters"
          >重置筛选</button>
          <button v-else class="button secondary small" type="button" :disabled="loading" @click="loadMonitor()">
            重新加载
          </button>
        </div>
      </div>
      <footer class="table-footer">
        <span><span class="status-dot neutral"></span>{{ filteredRows.length }} / {{ rows.length }} 个对象</span>
        <span>数据来自服务端健康快照；操作会立即同步配置状态</span>
      </footer>
    </section>

    <div v-if="upstreamDeleteTarget" class="modal-backdrop confirmation-backdrop" @click.self="closeUpstreamDelete">
      <form
        class="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="monitor-delete-upstream-title"
        @submit.prevent="confirmDeleteUpstream"
      >
        <span class="confirm-icon archive"><ConsoleIcon name="trash" :size="22" /></span>
        <h2 id="monitor-delete-upstream-title">
          {{ needsIdConfirmation ? "永久删除此上游？" : "配置来源不可删除" }}
        </h2>
        <p v-if="needsIdConfirmation">
          <strong>{{ upstreamDeleteTarget.name }}</strong>
          的配置、版本和审计记录将被永久删除，且无法恢复。
        </p>
        <p v-else>
          <strong>{{ upstreamDeleteTarget.name }}</strong>
          由配置目录管理；如需修改请前往上游接口目录。
        </p>
        <template v-if="needsIdConfirmation">
          <label for="monitor-delete-confirmation">输入插件 ID <code>{{ upstreamDeleteTarget.id }}</code> 以确认</label>
          <input
            id="monitor-delete-confirmation"
            v-model="upstreamDeleteConfirm"
            autocomplete="off"
            spellcheck="false"
            :placeholder="upstreamDeleteTarget.id"
          />
        </template>
        <div class="confirm-actions">
          <button class="button secondary" type="button" @click="closeUpstreamDelete">取消</button>
          <button
            class="button destructive"
            type="submit"
            :disabled="deleteBusy || (needsIdConfirmation && upstreamDeleteConfirm !== upstreamDeleteTarget.id)"
          >
            <span v-if="deleteBusy" class="spinner"></span>
            {{ needsIdConfirmation ? "永久删除" : "知道了" }}
          </button>
        </div>
      </form>
    </div>

    <div v-if="channelDeleteTarget" class="modal-backdrop confirmation-backdrop" @click.self="channelDeleteTarget = null">
      <form
        class="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="monitor-delete-channel-title"
        @submit.prevent="confirmDeleteChannel"
      >
        <span class="confirm-icon archive"><ConsoleIcon name="trash" :size="22" /></span>
        <h2 id="monitor-delete-channel-title">删除频道 @{{ channelDeleteTarget.id }}？</h2>
        <p v-if="channelDeleteTarget.origin === 'builtin'">
          频道将从生效清单中移除；之后可随时重新启用恢复。
        </p>
        <p v-else>该自定义频道将从清单中彻底移除。</p>
        <div class="confirm-actions">
          <button class="button secondary" type="button" @click="channelDeleteTarget = null">取消</button>
          <button class="button destructive" type="submit" :disabled="deleteBusy">
            <span v-if="deleteBusy" class="spinner"></span>确认删除
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
import ConsoleIcon from "../upstreams/ConsoleIcon.vue";
import {
  STATE_LABELS,
  STATE_TONES,
  buildMonitorRows,
  checkedAtText,
  extractMonitorData,
  filterRows,
  summarizeRows,
  withChannelEnabled,
  withRowRemoved,
  withRowRestored,
  withUpstreamEnabled,
  type MonitorFilter,
  type MonitorRow,
} from "./monitorView";

const emit = defineEmits<{
  (event: "unauthorized"): void;
  (event: "focus-upstream", id: string): void;
  (event: "debug-channel", channel: string): void;
}>();

const FILTERS: Array<{ label: string; value: MonitorFilter }> = [
  { label: "全部", value: "all" },
  { label: "上游", value: "upstream" },
  { label: "TG 频道", value: "channel" },
  { label: "异常", value: "error" },
  { label: "已停用", value: "inactive" },
];
const AUTO_REFRESH_MS = 30_000;
const AUTO_REFRESH_SECONDS = AUTO_REFRESH_MS / 1_000;

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
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

const summary = computed(() => summarizeRows(rows.value));
const filteredRows = computed(() => filterRows(rows.value, filter.value, search.value));
const generatedAtLabel = computed(() => {
  const ms = Date.parse(generatedAt.value);
  return Number.isFinite(ms)
    ? new Date(ms).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "";
});

const upstreamDeleteTarget = ref<MonitorRow | null>(null);
const upstreamDeleteConfirm = ref("");
const channelDeleteTarget = ref<MonitorRow | null>(null);
const needsIdConfirmation = computed(() => upstreamDeleteTarget.value?.upstreamKind === "instructions");

const autoRefresh = ref(true);
const nextRefreshIn = ref(AUTO_REFRESH_SECONDS);
let autoTimer: ReturnType<typeof setInterval> | undefined;
let countdownTimer: ReturnType<typeof setInterval> | undefined;

function apiErrorMessage(error: any): string {
  const code = error?.statusCode || error?.response?.status;
  if (code === 401) return "管理员密码错误，或管理会话已过期。";
  if (code === 403) return "请求被安全策略拒绝，请从当前站点重新打开页面。";
  if (code === 429) return "尝试次数过多，请稍后再试。";
  if (code === 503) return "服务端尚未配置 ADMIN_PASSWORD。";
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

function resetFilters() {
  filter.value = "all";
  search.value = "";
}

/** 上游启停：乐观更新 → 调用端点 → 重新拉取；失败回滚。 */
async function toggleUpstream(row: MonitorRow) {
  if (busyKey.value || deleteBusy.value) return;
  const next = !row.enabled;
  const snapshot = rows.value;
  busyKey.value = row.key;
  rows.value = withUpstreamEnabled(rows.value, row.id, next);
  try {
    const response = await $fetch<{ code?: number; message?: string }>(
      row.upstreamKind === "code"
        ? `/api/settings/upstreams/${encodeURIComponent(row.id)}/${next ? "enable" : "disable"}`
        : `/api/plugins/${encodeURIComponent(row.id)}/${next ? "enable" : "disable"}`,
      { method: "POST" },
    );
    if ((response.code ?? 0) !== 0) throw new Error(response.message || "操作未被接受");
    notify(`${row.name} 已${next ? "启用" : "停用"}。`);
    await loadMonitor({ silent: true });
  } catch (error: any) {
    rows.value = snapshot;
    if ((error?.statusCode || error?.response?.status) === 401) emit("unauthorized");
    else notify(`操作失败：${apiErrorMessage(error)}`);
  } finally {
    busyKey.value = "";
  }
}

/** 频道启停（已删除频道走启用即恢复）；乐观更新，失败回滚。 */
async function toggleChannel(row: MonitorRow) {
  if (busyKey.value || deleteBusy.value) return;
  const next = !(row.enabled && !row.trashed);
  const snapshot = rows.value;
  busyKey.value = row.key;
  rows.value = next
    ? withRowRestored(rows.value, row.key)
    : withChannelEnabled(rows.value, row.id, false);
  try {
    const response = await $fetch<{ code?: number; message?: string }>(
      `/api/tg/channels/${encodeURIComponent(row.id)}/${next ? "enable" : "disable"}`,
      { method: "POST" },
    );
    if ((response.code ?? 0) !== 0) throw new Error(response.message || "操作未被接受");
    notify(`@${row.id} 已${next ? (row.trashed ? "恢复" : "启用") : "停用"}。`);
    await loadMonitor({ silent: true });
  } catch (error: any) {
    rows.value = snapshot;
    if ((error?.statusCode || error?.response?.status) === 401) emit("unauthorized");
    else notify(`操作失败：${apiErrorMessage(error)}`);
  } finally {
    busyKey.value = "";
  }
}

function requestDeleteUpstream(row: MonitorRow) {
  if (row.upstreamKind !== "instructions" || busyKey.value || deleteBusy.value) return;
  upstreamDeleteTarget.value = row;
  upstreamDeleteConfirm.value = "";
}

function closeUpstreamDelete() {
  if (deleteBusy.value) return;
  upstreamDeleteTarget.value = null;
  upstreamDeleteConfirm.value = "";
}


async function confirmDeleteUpstream() {
  const target = upstreamDeleteTarget.value;
  if (!target || deleteBusy.value) return;
  if (target.upstreamKind === "instructions" && upstreamDeleteConfirm.value !== target.id) return;
  deleteBusy.value = true;
  const snapshot = rows.value;
  try {
    if (target.upstreamKind === "instructions") {
      await $fetch(`/api/plugins/${encodeURIComponent(target.id)}`, {
        method: "DELETE",
        body: { confirmation: target.id, actor: "monitor-console" },
      });
      notify(`${target.name} 已永久删除。`);
    } else {
      // 配置来源不会进入删除流程；保留防御分支，避免旧页面调用造成误操作。
      rows.value = snapshot;
      notify("配置来源不可删除，请前往上游接口目录修改或停用。");
      return;
    }
    upstreamDeleteTarget.value = null;
    upstreamDeleteConfirm.value = "";
    await loadMonitor({ silent: true });
  } catch (error: any) {
    rows.value = snapshot;
    if ((error?.statusCode || error?.response?.status) === 401) emit("unauthorized");
    else notify(`删除失败：${apiErrorMessage(error)}`);
  } finally {
    deleteBusy.value = false;
  }
}

function requestDeleteChannel(row: MonitorRow) {
  if (busyKey.value || deleteBusy.value) return;
  channelDeleteTarget.value = row;
}

async function confirmDeleteChannel() {
  const target = channelDeleteTarget.value;
  if (!target || deleteBusy.value) return;
  deleteBusy.value = true;
  const snapshot = rows.value;
  try {
    const response = await $fetch<{ code?: number; message?: string }>(
      `/api/tg/channels/${encodeURIComponent(target.id)}`,
      { method: "DELETE" },
    );
    // 自定义频道删除成功后 deleted 会回到 false（已从清单移除），只看业务码。
    if ((response.code ?? 0) !== 0) {
      rows.value = snapshot;
      notify(response.message || "删除未生效，请稍后重试。");
      return;
    }
    rows.value = withRowRemoved(rows.value, target.key);
    channelDeleteTarget.value = null;
    notify(
      target.origin === "builtin"
        ? `@${target.id} 已从生效清单移除，可重新启用恢复。`
        : `@${target.id} 已删除。`,
    );
    await loadMonitor({ silent: true });
  } catch (error: any) {
    rows.value = snapshot;
    if ((error?.statusCode || error?.response?.status) === 401) emit("unauthorized");
    else notify(`删除失败：${apiErrorMessage(error)}`);
  } finally {
    deleteBusy.value = false;
  }
}

onMounted(async () => {
  if (!loaded.value) await loadMonitor();
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
.monitor-avatar[data-kind="channel"] {
  --source-color: #7c8790;
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
