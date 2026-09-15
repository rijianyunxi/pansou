<template>
  <AdminAccessGate
    v-if="adminChecking || adminLocked"
    :checking="adminChecking"
    :configured="adminConfigured"
    :busy="adminUnlocking"
    :ready="clientReady"
    :error="authError"
    title="Telegram 管理员验证"
    description="频道清单、诊断请求和来源原始响应属于敏感运维数据。验证成功后会建立 8 小时的独立管理会话。"
    @submit="unlockAdmin"
    @clear-error="authError = ''"
  />
  <div v-else class="tg-test-page" :data-ready="clientReady ? 'true' : 'false'">
    <header class="tg-head">
      <div>
        <p class="tg-kicker">TELEGRAM CHANNEL DIAGNOSTICS</p>
        <h1>Telegram 频道测试</h1>
        <p class="tg-subtitle">
          检查公开频道是否可访问，并验证关键词能否提取出网盘链接。
        </p>
      </div>
      <div class="tg-head-actions">
        <span class="tg-admin-session"><ConsoleIcon name="shield" :size="14" />管理员会话</span>
        <button class="tg-back tg-logout" type="button" @click="lockAdmin">
          <ConsoleIcon name="logout" :size="14" />退出管理
        </button>
        <NuxtLink to="/admin/telegram" class="tg-back">返回 Telegram 频道管理</NuxtLink>
        <NuxtLink to="/admin/monitor" class="tg-back">运行监控</NuxtLink>
      </div>
    </header>

    <section class="tg-controls">
      <label
        ><span>测试关键词</span
        ><input
          v-model="keyword"
          maxlength="100"
          placeholder="例如：三体"
          @keydown.enter="testAll"
      /></label>
      <label class="limit-field"
        ><span>每频道最多结果</span
        ><select v-model.number="limit">
          <option :value="10">10</option>
          <option :value="20">20</option>
          <option :value="50">50</option>
        </select></label
      >
      <button
        class="tg-button primary"
        :disabled="runningCount > 0 || !keyword.trim()"
        @click="testAll"
      >
        {{ runningCount ? `测试中 ${runningCount}` : "测试全部频道" }}
      </button>
      <button
        class="tg-button secondary"
        :disabled="runningCount > 0"
        @click="clearReports"
      >
        清除记录
      </button>
    </section>

    <section class="tg-custom">
      <div>
        <strong>测试其他公开频道</strong>
        <p>
          支持公开频道用户名和 <code>t.me</code> 链接，仅用于临时测试，不会修改已保存配置。
        </p>
      </div>
      <input
        v-model="customChannel"
        placeholder="公开频道用户名"
        maxlength="64"
        @keydown.enter="testCustom"
      />
      <button
        class="tg-button secondary"
        :disabled="runningCount > 0 || !customChannel.trim() || !keyword.trim()"
        @click="testCustom"
      >
        测试此频道
      </button>
    </section>

    <div v-if="notice" class="tg-notice" role="status">{{ notice }}</div>
    <section class="tg-summary">
      <div>
        <span>已配置公开频道</span><strong>{{ channels.length }}</strong>
      </div>
      <div>
        <span>已测试</span><strong>{{ testedCount }}</strong>
      </div>
      <div>
        <span>可提取结果</span
        ><strong class="green">{{ availableCount }}</strong>
      </div>
      <div>
        <span>待确认 / 异常</span
        ><strong>{{ warningCount + errorCount }}</strong>
      </div>
    </section>

    <section class="tg-layout">
      <div class="tg-list-card">
        <div class="tg-card-head">
          <div>
            <h2>已配置频道</h2>
            <p>来自已生效的服务端配置；临时测试频道不会自动加入已保存清单</p>
          </div>
          <span>{{ channels.length }} CHANNELS</span>
        </div>
        <div class="tg-filter">
          <button
            v-for="filter in filters"
            :key="filter.value"
            :class="{ active: stateFilter === filter.value }"
            @click="stateFilter = filter.value"
          >
            {{ filter.label
            }}<small v-if="filter.value === 'all'">{{
              channels.length
            }}</small></button
          ><input v-model="search" placeholder="搜索频道" />
        </div>
        <div class="tg-channel-list">
          <button
            v-for="channel in filteredChannels"
            :key="channel"
            class="tg-channel-row"
            :class="{ selected: selectedChannel === channel }"
            @click="selectedChannel = channel"
          >
            <span class="tg-channel-avatar">@</span
            ><span class="tg-channel-name"
              ><strong>{{ channel }}</strong
              ><small>https://t.me/s/{{ channel }}</small></span
            ><span class="tg-state" :class="state(channel)"
              ><i></i>{{ stateLabel(channel) }}</span
            ><span class="tg-latency">{{
              reports[channel] ? `${reports[channel].elapsedMs} ms` : "—"
            }}</span>
          </button>
          <div v-if="!filteredChannels.length" class="tg-empty">
            没有符合条件的频道
          </div>
        </div>
      </div>

      <div class="tg-detail-card">
        <template v-if="selectedChannel">
          <div class="tg-detail-head">
            <span class="tg-channel-avatar large">@</span>
            <div>
              <h2>
                {{ selectedChannel }} <span class="tg-public">PUBLIC</span>
              </h2>
              <p>公开频道页面探测</p>
            </div>
            <button
              class="tg-button secondary tg-debug-button"
              :disabled="runningCount > 0 || !keyword.trim()"
              @click="testChannel(selectedChannel)"
              title="只测试当前选中的频道"
            >
              {{ running[selectedChannel] ? "测试中…" : "单个测试" }}
            </button>
          </div>
          <div class="tg-detail-body">
            <div class="tg-detail-meta">
              <div>
                <span>测试关键词</span><strong>{{ keyword || "—" }}</strong>
              </div>
              <div>
                <span>请求入口</span
                ><strong>{{ selectedRequestUrl }}</strong>
              </div>
              <div>
                <span>最近耗时</span
                ><strong>{{
                  selectedReport ? `${selectedReport.elapsedMs} ms` : "—"
                }}</strong>
              </div>
            </div>
            <div
              v-if="selectedReport"
              class="tg-result-box"
              :class="selectedReport.state"
            >
              <div class="tg-result-title">
                <i></i><strong>{{ selectedReport.message }}</strong
                ><span>{{
                  selectedReport.route === "jina"
                    ? "Jina fallback"
                    : selectedReport.route === "telegram"
                      ? "Telegram web"
                      : "—"
                }}</span>
              </div>
              <p>
                HTTP {{ selectedReport.httpStatus ?? "未取得" }} ·
                {{ formatTime(selectedReport.checkedAt || "") }} ·
                {{ selectedReport.results.length }} 条统一结果
              </p>
            </div>
            <div v-else class="tg-placeholder">
              还没有测试记录。点击右上角“单个测试”，或使用上方“测试全部频道”。
            </div>
            <section v-if="selectedReport" class="tg-debug-panel">
              <div class="tg-debug-panel-head">
                <div>
                  <h3>单个测试报文</h3>
                  <p>展示本次诊断接口入参、出参，以及实际访问来源的原始请求和响应。</p>
                </div>
                <span>{{ selectedReport.attempts.length }} 次来源请求</span>
              </div>
              <div class="tg-debug-grid">
                <div class="tg-debug-block">
                  <div class="tg-debug-block-head">
                    <strong>接口入参</strong><span>POST /api/tg/probe</span>
                    <TelegramCopyButton v-if="selectedInputJson" compact :text="selectedInputJson" label="复制入参" />
                  </div>
                  <pre>{{ formatJson(selectedInput) }}</pre>
                </div>
                <div class="tg-debug-block">
                  <div class="tg-debug-block-head">
                    <strong>接口出参</strong><span>JSON</span>
                    <TelegramCopyButton v-if="selectedOutputJson" compact :text="selectedOutputJson" label="复制出参 JSON" />
                  </div>
                  <pre>{{ formatJson(structuredOutput(selectedReport)) }}</pre>
                </div>
              </div>
              <div class="tg-debug-grid">
                <div class="tg-debug-block">
                  <div class="tg-debug-block-head">
                    <strong>来源原始请求</strong><span>{{ selectedReport.upstreamRequest?.method || "—" }}</span>
                  </div>
                  <pre>{{ formatJson(selectedReport.upstreamRequest) }}</pre>
                </div>
                <div class="tg-debug-block">
                  <div class="tg-debug-block-head">
                    <strong>来源原始响应</strong><span>HTTP {{ selectedReport.upstreamResponse?.status ?? "—" }}</span>
                  </div>
                  <div class="tg-raw-view-slot">
                    <TelegramRawBodyView
                      :body="selectedReport.upstreamResponse?.body || ''"
                      :keyword="selectedReport.keyword"
                      :body-length="selectedReport.upstreamResponse?.bodyLength ?? null"
                      :truncated="!!selectedReport.upstreamResponse?.bodyTruncated"
                      :base-url="selectedReport.upstreamRequest?.url || ''"
                      frame-title="来源响应渲染"
                    />
                  </div>
                </div>
              </div>
              <div class="tg-stage-wrap">
                <TelegramStageCompare
                  :stages="selectedReport.stages"
                  :failure-kind="selectedReport.failureKind ?? null"
                  :elapsed-ms="selectedReport.elapsedMs"
                />
              </div>
              <details v-if="selectedReport.attempts.length > 1" class="tg-attempts">
                <summary>查看全部来源尝试（{{ selectedReport.attempts.length }}）</summary>
                <div v-for="(attempt, index) in selectedReport.attempts" :key="`${attempt.route}-${index}`" class="tg-attempt">
                  <div class="tg-attempt-head">
                    <strong>#{{ index + 1 }} {{ attempt.route === "telegram" ? "Telegram web" : "Jina fallback" }}</strong>
                    <span>{{ attempt.elapsedMs }} ms · HTTP {{ attempt.response?.status ?? "请求失败" }}</span>
                  </div>
                  <pre>{{ formatJson(attempt) }}</pre>
                </div>
              </details>
            </section>
            <div v-if="selectedReport?.results.length" class="tg-results">
              <div class="tg-results-head">
                <h3>提取结果</h3>
                <span>SearchResult[]</span>
              </div>
              <article
                v-for="item in selectedReport.results"
                :key="item.id"
              >
                <strong>{{ item.name || "无标题" }}</strong>
                <p>
                  {{
                    item.links
                      .map(
                        (link) =>
                          `${link.type}: ${link.url}${link.password ? ` · 密码 ${link.password}` : ""}`,
                      )
                      .join("；")
                  }}
                </p>
              </article>
            </div>
            <div class="tg-explain">
              <strong>检测说明</strong>
              <p>
                页面首先访问 Telegram 公开频道；如果正文结构不可识别，再尝试
                Jina 镜像。该测试不使用 Bot
                Token，不访问私有频道，也不接受任意网址。
              </p>
            </div>
          </div>
        </template>
        <div v-else class="tg-placeholder">从左侧选择一个频道。</div>
      </div>
    </section>
    <p class="tg-footnote">
      开发诊断页 · 单次最多 2 个并发测试 ·
      结果保存在当前浏览器内存，不会修改正式搜索配置
    </p>
  </div>
</template>

<script setup lang="ts">
import AdminAccessGate from "../../components/admin/AdminAccessGate.vue";
import ConsoleIcon from "../../components/upstreams/ConsoleIcon.vue";
import TelegramCopyButton from "../../components/telegram/TelegramCopyButton.vue";
import TelegramRawBodyView from "../../components/telegram/TelegramRawBodyView.vue";
import TelegramStageCompare from "../../components/telegram/TelegramStageCompare.vue";
import { parseTelegramChannelInput } from "../../utils/telegramChannelInput";
import { buildTgSourceUrl, type TgSourceUrlSettings } from "../../utils/tgSourceUrl";
import type { TgProbeResult } from "../../server/core/services/tg";
useHead({
  title: "Telegram 频道诊断",
  meta: [{ name: "robots", content: "noindex, nofollow" }],
});

type StateFilter = "all" | "available" | "warning" | "error" | "untested";
const clientReady = ref(false);
const authStatus = await useFetch<{ configured: boolean; locked: boolean }>(
  "/api/auth/admin-status",
  { key: "telegram-admin-status", server: true },
);
const initialAuthStatus = authStatus.data.value;
const adminChecking = ref(!initialAuthStatus && !authStatus.error.value);
const adminConfigured = ref(initialAuthStatus?.configured ?? true);
const adminLocked = ref(initialAuthStatus?.locked ?? true);
const adminUnlocking = ref(false);
const authError = ref("");
const configuredChannels = ref<string[]>([]);
const sourceSettings = ref<TgSourceUrlSettings>({});
const route = useRoute();
const extraChannels = ref<string[]>([]);
const channels = computed(() =>
  Array.from(new Set([...configuredChannels.value, ...extraChannels.value])),
);
const keyword = ref("三体");
const limit = ref(20);
const customChannel = ref("");
const selectedChannel = ref(channels.value[0] || "");
const reports = ref<Record<string, TgProbeResult>>({});
const requestInputs = ref<
  Record<string, { channel: string; keyword: string; limit: number }>
>({});
const running = ref<Record<string, boolean>>({});
const search = ref("");
const stateFilter = ref<StateFilter>("all");
const notice = ref("");
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
const filters = [
  { label: "全部", value: "all" as StateFilter },
  { label: "可用", value: "available" as StateFilter },
  { label: "待确认", value: "warning" as StateFilter },
  { label: "异常", value: "error" as StateFilter },
  { label: "未测试", value: "untested" as StateFilter },
];
const runningCount = computed(
  () => Object.values(running.value).filter(Boolean).length,
);
const testedCount = computed(() => Object.keys(reports.value).length);
const availableCount = computed(
  () =>
    Object.values(reports.value).filter((r) => r.state === "available").length,
);
const warningCount = computed(
  () =>
    Object.values(reports.value).filter((r) => r.state === "warning").length,
);
const errorCount = computed(
  () => Object.values(reports.value).filter((r) => r.state === "error").length,
);
const selectedReport = computed(() => reports.value[selectedChannel.value]);
const selectedRequestUrl = computed(() => {
  return buildTgSourceUrl("direct", selectedChannel.value, keyword.value, undefined, sourceSettings.value);
});
const selectedInput = computed(
  () => requestInputs.value[selectedChannel.value] || null,
);
const filteredChannels = computed(() =>
  channels.value.filter((channel) => {
    const state = stateOf(channel);
    return (
      (stateFilter.value === "all" || state === stateFilter.value) &&
      channel.toLowerCase().includes(search.value.toLowerCase())
    );
  }),
);
type ReportState = Exclude<StateFilter, "all">;
function stateOf(channel: string): ReportState {
  return reports.value[channel]?.state || "untested";
}
function state(channel: string) {
  return stateOf(channel);
}
function stateLabel(channel: string): string {
  const labels: Record<ReportState, string> = {
    available: "可用",
    warning: "待确认",
    error: "异常",
    untested: "未测试",
  };
  return labels[stateOf(channel)];
}
function formatTime(value: string) {
  return value
    ? new Date(value).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
}
function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2) || "null";
}
function structuredOutput(report: TgProbeResult) {
  return {
    ...report,
    upstreamResponse: report.upstreamResponse
      ? {
          ...report.upstreamResponse,
          body: `[原始响应正文见下方，共 ${report.upstreamResponse.bodyLength} 字符]`,
        }
      : null,
  };
}
const selectedInputJson = computed(() =>
  selectedInput.value ? formatJson(selectedInput.value) : "",
);
const selectedOutputJson = computed(() =>
  selectedReport.value ? formatJson(structuredOutput(selectedReport.value)) : "",
);

function showNotice(message: string) {
  notice.value = message;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = ""), 4000);
}
function adminErrorMessage(error: any): string {
  const code = error?.statusCode || error?.response?.status;
  if (code === 401) return "管理员密码错误，或管理会话已过期。";
  if (code === 403) return "请求被安全策略拒绝，请从当前站点重新打开控制台。";
  if (code === 429) return "尝试次数过多，请稍后再试。";
  if (code === 503) return "服务端尚未配置 ADMIN_PASSWORD。";
  return error?.data?.statusMessage || error?.message || "管理操作失败。";
}
async function checkAdminSession() {
  adminChecking.value = true;
  try {
    const status = await $fetch<{ configured: boolean; locked: boolean }>(
      "/api/auth/admin-status",
    );
    adminConfigured.value = status.configured;
    adminLocked.value = status.locked;
    if (!status.locked) await loadConfiguredChannels();
  } catch (error: any) {
    adminConfigured.value = false;
    adminLocked.value = true;
    authError.value = adminErrorMessage(error);
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
    await loadConfiguredChannels();
    showNotice("Telegram 管理控制台已解锁。");
  } catch (error: any) {
    authError.value = adminErrorMessage(error);
  } finally {
    adminUnlocking.value = false;
  }
}
async function lockAdmin() {
  try {
    await $fetch("/api/auth/admin-lock", { method: "POST" });
  } finally {
    reports.value = {};
    requestInputs.value = {};
    running.value = {};
    adminLocked.value = true;
    authError.value = "";
  }
}
async function testChannel(channel: string) {
  if (running.value[channel] || !keyword.value.trim()) return;
  const payload = {
    channel,
    keyword: keyword.value.trim(),
    limit: limit.value,
  };
  requestInputs.value[channel] = payload;
  running.value[channel] = true;
  selectedChannel.value = channel;
  try {
    reports.value[channel] = await $fetch<TgProbeResult>("/api/tg/probe", {
      method: "POST",
      body: payload,
      retry: 0,
    });
  } catch (error: any) {
    const code = error?.statusCode || error?.response?.status;
    if (code === 401) adminLocked.value = true;
    showNotice(adminErrorMessage(error));
  } finally {
    running.value[channel] = false;
  }
}
async function testCustom() {
  const channel = parseTelegramChannelInput(customChannel.value);
  if (!channel) { showNotice("请输入有效的公开频道用户名或链接，不支持私密频道。"); return; }
  if (!channels.value.includes(channel)) extraChannels.value.push(channel);
  selectedChannel.value = channel;
  customChannel.value = "";
  await testChannel(channel);
}
/** 已关闭/已删除的频道不参与批量测试；监控接口不可用时不跳过任何频道（兜底）。 */
async function inactiveChannelSet(): Promise<Set<string>> {
  try {
    const response = await $fetch<{
      data?: { channels?: Array<{ channel?: string; enabled?: boolean; deleted?: boolean }> };
    }>("/api/monitor");
    const entries = response.data?.channels ?? [];
    return new Set(
      entries
        .filter((item) => item.enabled === false || item.deleted === true)
        .map((item) => String(item.channel || "").replace(/^@/, "")),
    );
  } catch {
    return new Set();
  }
}
async function testAll() {
  if (runningCount.value || !keyword.value.trim()) return;
  const inactive = await inactiveChannelSet();
  const pending = filteredChannels.value.filter((channel) => !inactive.has(channel));
  for (const channel of pending) await testChannel(channel);
  const skipped = filteredChannels.value.length - pending.length;
  showNotice(
    `已完成 ${pending.length} 个频道测试${skipped > 0 ? `（跳过 ${skipped} 个已关闭/已删除频道）` : ""}`,
  );
}
function clearReports() {
  reports.value = {};
  requestInputs.value = {};
  showNotice("已清除频道测试记录");
}
async function loadConfiguredChannels() {
  try {
    const [channelResponse, sourceResponse] = await Promise.all([
      $fetch<{ data: { effectiveChannels: string[] } }>("/api/settings/telegram"),
      $fetch<{ data: TgSourceUrlSettings }>("/api/settings/tg-source"),
    ]);
    configuredChannels.value = channelResponse.data.effectiveChannels;
    sourceSettings.value = sourceResponse.data || {};
    const requested = typeof route.query.channel === "string" ? parseTelegramChannelInput(route.query.channel) : null;
    if (requested && !channels.value.includes(requested)) extraChannels.value.push(requested);
    selectedChannel.value = requested || channels.value[0] || "";
  } catch (error: any) {
    if ((error?.statusCode || error?.response?.status) === 401) adminLocked.value = true;
    showNotice(adminErrorMessage(error));
  }
}
onMounted(async () => {
  clientReady.value = true;
  if (adminChecking.value) await checkAdminSession();
  else if (!adminLocked.value) await loadConfiguredChannels();
});
onBeforeUnmount(() => {
  if (noticeTimer) clearTimeout(noticeTimer);
});
</script>

<style scoped>
.tg-test-page {
  max-width: 1380px;
  margin: 0 auto;
  padding: 36px 26px 50px;
  color: #111827;
}
.tg-head {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  align-items: flex-start;
  margin-bottom: 25px;
}
.tg-kicker {
  font:
    600 10px ui-monospace,
    monospace;
  letter-spacing: 1.6px;
  color: #6b7280;
  margin: 0 0 8px;
}
.tg-head h1 {
  font-size: 28px;
  letter-spacing: -0.6px;
  margin: 0;
}
.tg-subtitle {
  font-size: 12px;
  color: #6b7280;
  margin: 8px 0 0;
}
.tg-back {
  border: 1px solid #e5e7eb;
  border-radius: 7px;
  background: #fff;
  padding: 9px 13px;
  color: #4b5563;
  font-size: 11px;
  text-decoration: none;
}
.tg-controls,
.tg-custom {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  padding: 18px;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  margin-bottom: 14px;
}
.tg-controls label {
  flex: 1;
}
.tg-controls label span,
.tg-custom > div strong {
  display: block;
  color: #6b7280;
  font-size: 10px;
  margin-bottom: 7px;
}
.tg-controls input,
.tg-controls select,
.tg-custom input {
  height: 39px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 0 11px;
  background: #fff;
  color: #1f2937;
  outline: none;
  width: 100%;
  font: 12px inherit;
}
.tg-controls input:focus,
.tg-controls select:focus,
.tg-custom input:focus {
  border-color: #93c5fd;
  box-shadow: 0 0 0 3px #93c5fd18;
}
.limit-field {
  max-width: 150px;
}
.tg-button {
  height: 39px;
  border-radius: 6px;
  padding: 0 14px;
  border: 1px solid #e5e7eb;
  background: #fff;
  color: #4b5563;
  font-size: 11px;
  white-space: nowrap;
}
.tg-button.primary {
  background: #2563eb;
  border-color: #2563eb;
  color: #fff;
}
.tg-button:disabled,
.tg-icon-button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.tg-custom {
  align-items: center;
}
.tg-custom > div {
  flex: 1;
}
.tg-custom > div p {
  margin: 0;
  color: #6b7280;
  font-size: 10px;
}
.tg-custom code,
.tg-card-head code {
  font-family: ui-monospace, monospace;
}
.tg-custom input {
  max-width: 300px;
}
.tg-notice {
  background: #fff8e9;
  border: 1px solid #f0e1b9;
  color: #b45309;
  border-radius: 7px;
  padding: 11px 14px;
  margin-bottom: 14px;
  font-size: 11px;
}
.tg-summary {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 20px;
}
.tg-summary > div {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 9px;
  padding: 15px 17px;
}
.tg-summary span {
  display: block;
  color: #6b7280;
  font-size: 10px;
}
.tg-summary strong {
  font-size: 24px;
  margin-top: 8px;
  display: block;
}
.tg-summary strong.green {
  color: #2563eb;
}
.tg-layout {
  display: grid;
  grid-template-columns: minmax(420px, 0.9fr) minmax(400px, 1.1fr);
  gap: 18px;
  align-items: start;
}
.tg-list-card,
.tg-detail-card {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  overflow: hidden;
}
.tg-card-head,
.tg-detail-head {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 20px;
  border-bottom: 1px solid #f3f4f6;
}
.tg-card-head h2,
.tg-detail-head h2 {
  font-size: 14px;
  margin: 0;
}
.tg-card-head p,
.tg-detail-head p {
  font-size: 10px;
  color: #9ca3af;
  margin: 4px 0 0;
}
.tg-card-head > span {
  margin-left: auto;
  color: #9ca3af;
  font:
    9px ui-monospace,
    monospace;
}
.tg-filter {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 14px 17px;
  border-bottom: 1px solid #f3f4f6;
  flex-wrap: wrap;
}
.tg-filter button {
  border: 0;
  background: #f6f7f9;
  color: #6b7280;
  border-radius: 4px;
  padding: 7px 8px;
  font-size: 10px;
}
.tg-filter button.active {
  background: #eff6ff;
  color: #1d4ed8;
  font-weight: 600;
}
.tg-filter button small {
  margin-left: 4px;
}
.tg-filter input {
  margin-left: auto;
  width: 135px;
  height: 30px;
  border: 1px solid #e5e7eb;
  border-radius: 5px;
  padding: 0 8px;
  font-size: 10px;
  outline: none;
}
.tg-channel-list {
  max-height: 610px;
  overflow: auto;
}
.tg-channel-row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 62px;
  padding: 10px 17px;
  text-align: left;
  border: 0;
  border-bottom: 1px solid #f3f4f6;
  background: #fff;
  color: #1f2937;
}
.tg-channel-row:hover {
  background: #f6f7f9;
}
.tg-channel-row.selected {
  background: #eff6ff;
  box-shadow: inset 3px 0 #2563eb;
}
.tg-channel-avatar {
  display: grid;
  place-items: center;
  width: 31px;
  height: 31px;
  flex: 0 0 31px;
  border-radius: 8px;
  background: #eff6ff;
  color: #2563eb;
  font-weight: 700;
  font-size: 13px;
}
.tg-channel-avatar.large {
  width: 39px;
  height: 39px;
  flex-basis: 39px;
  font-size: 17px;
}
.tg-channel-name {
  min-width: 0;
  flex: 1;
}
.tg-channel-name strong {
  font-size: 11px;
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tg-channel-name small {
  display: block;
  color: #9ca3af;
  font:
    9px ui-monospace,
    monospace;
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tg-state {
  display: flex;
  align-items: center;
  gap: 5px;
  color: #6b7280;
  background: #f3f4f6;
  padding: 4px 6px;
  border-radius: 4px;
  font-size: 9px;
  white-space: nowrap;
}
.tg-state i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #9ca3af;
}
.tg-state.available {
  background: #eff6ff;
  color: #2563eb;
}
.tg-state.available i {
  background: #2563eb;
}
.tg-state.warning {
  background: #fff7e8;
  color: #b45309;
}
.tg-state.warning i {
  background: #d3a344;
}
.tg-state.error {
  background: #fff0ef;
  color: #dc2626;
}
.tg-state.error i {
  background: #d86b65;
}
.tg-latency {
  width: 61px;
  text-align: right;
  color: #9ca3af;
  font:
    9px ui-monospace,
    monospace;
}
.tg-empty {
  text-align: center;
  padding: 44px;
  color: #9ca3af;
  font-size: 11px;
}
.tg-detail-head {
  padding: 22px;
}
.tg-detail-head > div {
  flex: 1;
}
.tg-public {
  font:
    8px ui-monospace,
    monospace;
  color: #2563eb;
  border: 1px solid #d1fae5;
  border-radius: 3px;
  padding: 2px 4px;
  vertical-align: middle;
}
.tg-icon-button {
  border: 0;
  background: transparent;
  color: #6b7280;
  font-size: 22px;
  min-width: 36px;
  min-height: 36px;
  border-radius: 6px;
}
.tg-icon-button:hover:not(:disabled) {
  background: #eff6ff;
  color: #2563eb;
}
.tg-detail-body {
  padding: 22px;
}
.tg-detail-meta {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin-bottom: 18px;
}
.tg-detail-meta > div {
  background: #f9fafb;
  border: 1px solid #f3f4f6;
  border-radius: 6px;
  padding: 11px;
}
.tg-detail-meta span {
  display: block;
  font-size: 9px;
  color: #9ca3af;
}
.tg-detail-meta strong {
  display: block;
  font-size: 10px;
  margin-top: 6px;
  overflow-wrap: anywhere;
}
.tg-result-box {
  border-radius: 7px;
  padding: 14px;
  margin-bottom: 20px;
}
.tg-result-box.available {
  background: #eff6ff;
  border: 1px solid #d1fae5;
}
.tg-result-box.warning {
  background: #fff9ed;
  border: 1px solid #f1e5c8;
}
.tg-result-box.error {
  background: #fff2f1;
  border: 1px solid #f0d8d5;
}
.tg-result-title {
  display: flex;
  align-items: center;
  gap: 7px;
}
.tg-result-title i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #9ca3af;
}
.tg-result-box.available .tg-result-title i {
  background: #2563eb;
}
.tg-result-box.warning .tg-result-title i {
  background: #f59e0b;
}
.tg-result-box.error .tg-result-title i {
  background: #d57169;
}
.tg-result-title strong {
  font-size: 11px;
  flex: 1;
}
.tg-result-title span {
  font:
    9px ui-monospace,
    monospace;
  color: #6b7280;
}
.tg-result-box p {
  font-size: 9px;
  color: #9ca3af;
  margin: 8px 0 0;
}
.tg-placeholder {
  border: 1px dashed #e5e7eb;
  border-radius: 7px;
  padding: 42px 18px;
  text-align: center;
  color: #9ca3af;
  font-size: 11px;
  margin-bottom: 20px;
}
.tg-results {
  border-top: 1px solid #f3f4f6;
  padding-top: 18px;
}
.tg-results-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 7px;
}
.tg-results-head h3 {
  font-size: 12px;
  margin: 0;
}
.tg-results-head span {
  font:
    9px ui-monospace,
    monospace;
  color: #9ca3af;
}
.tg-results article {
  padding: 11px 0;
  border-bottom: 1px solid #f3f4f6;
}
.tg-results article strong {
  font-size: 11px;
}
.tg-results article p {
  font:
    9px/1.8 ui-monospace,
    monospace;
  color: #6b7280;
  margin: 4px 0 0;
  overflow-wrap: anywhere;
}
.tg-debug-panel {
  margin: 20px 0;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #f9fafb;
  overflow: hidden;
}
.tg-debug-panel-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
  padding: 14px;
  border-bottom: 1px solid #e5e7eb;
}
.tg-debug-panel-head h3 {
  margin: 0;
  font-size: 12px;
}
.tg-debug-panel-head p {
  margin: 5px 0 0;
  color: #6b7280;
  font-size: 9px;
}
.tg-debug-panel-head > span,
.tg-debug-block-head span,
.tg-attempt-head span {
  color: #9ca3af;
  font: 9px ui-monospace, monospace;
  white-space: nowrap;
}
.tg-debug-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  padding: 12px 14px 0;
}
.tg-debug-block {
  min-width: 0;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  overflow: hidden;
  background: #fff;
}
.tg-debug-block-head,
.tg-attempt-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
  padding: 9px 10px;
  background: #f3f4f6;
  border-bottom: 1px solid #e5e7eb;
  flex-wrap: wrap;
}
.tg-debug-block-head strong,
.tg-attempt-head strong {
  font-size: 10px;
}
.tg-debug-block pre,
.tg-attempt pre {
  margin: 0;
  padding: 10px;
  min-height: 100px;
  max-height: 280px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: #4b5563;
  font: 9px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.tg-debug-block .tg-raw-view-slot {
  padding: 10px;
}
.tg-debug-block-head .tg-copy {
  margin-left: auto;
}
.tg-stage-wrap {
  padding: 12px 14px 0;
}
.tg-attempts {
  margin: 12px 14px 14px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  overflow: hidden;
  background: #fff;
}
.tg-attempts summary {
  cursor: pointer;
  padding: 10px;
  color: #4b5563;
  font-size: 10px;
  background: #f3f4f6;
}
.tg-attempt {
  border-top: 1px solid #e5e7eb;
}
.tg-attempt pre {
  max-height: 220px;
}
.tg-debug-button {
  flex: none !important;
  white-space: nowrap;
}
.tg-explain {
  margin-top: 20px;
  background: #f6f7f9;
  border-radius: 7px;
  padding: 13px;
  color: #6b7280;
}
.tg-explain strong {
  font-size: 10px;
}
.tg-explain p {
  font-size: 9px;
  line-height: 1.9;
  margin: 6px 0 0;
}
.tg-footnote {
  text-align: center;
  color: #9ca3af;
  font-size: 9px;
  margin: 22px 0 0;
}
@media (max-width: 900px) {
  .tg-test-page {
    padding: 24px 16px;
  }
  .tg-layout {
    grid-template-columns: 1fr;
  }
  .tg-detail-card {
    order: -1;
  }
  .tg-summary {
    gap: 8px;
  }
  .tg-summary > div {
    padding: 12px;
  }
  .tg-summary strong {
    font-size: 21px;
  }
}
@media (max-width: 620px) {
  .tg-head {
    display: block;
  }
  .tg-back {
    display: inline-block;
    margin-top: 15px;
  }
  .tg-controls,
  .tg-custom {
    display: grid;
    grid-template-columns: 1fr 1fr;
    align-items: end;
  }
  .tg-controls label,
  .tg-custom > div {
    grid-column: 1/-1;
  }
  .limit-field {
    max-width: none;
  }
  .tg-controls .tg-button {
    width: 100%;
  }
  .tg-custom input {
    max-width: none;
  }
  .tg-summary {
    grid-template-columns: repeat(2, 1fr);
  }
  .tg-detail-meta {
    grid-template-columns: 1fr;
  }
  .tg-debug-grid {
    grid-template-columns: 1fr;
  }
  .tg-debug-panel-head {
    display: block;
  }
  .tg-debug-panel-head > span {
    display: block;
    margin-top: 8px;
  }
  .tg-filter input {
    order: -1;
    width: 100%;
    margin-bottom: 4px;
  }
  .tg-channel-row {
    padding-left: 12px;
    padding-right: 12px;
  }
  .tg-latency {
    display: none;
  }
}

.tg-head-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}
.tg-admin-session {
  min-height: 38px;
  padding: 0 10px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid #e5e7eb;
  border-radius: 7px;
  color: #1d4ed8;
  background: #eff6ff;
  font-size: 10px;
}
.tg-logout {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.tg-test-page button:focus-visible,
.tg-test-page a:focus-visible,
.tg-test-page input:focus-visible,
.tg-test-page select:focus-visible {
  outline: 3px solid #93c5fd;
  outline-offset: 3px;
}
@media (max-width: 700px) {
  .tg-head-actions {
    width: 100%;
    justify-content: flex-start;
  }
  .tg-admin-session,
  .tg-back,
  .tg-button,
  .tg-filter button,
  .tg-icon-button {
    min-height: 44px;
  }
}
</style>
