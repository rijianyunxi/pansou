<template>
  <div class="tg-test-page">
    <header class="tg-head">
      <div>
        <p class="tg-kicker">TELEGRAM CHANNEL DIAGNOSTICS</p>
        <h1>Telegram 频道测试</h1>
        <p class="tg-subtitle">
          检查公开频道是否可访问，并验证关键词能否提取出网盘链接。
        </p>
      </div>
      <NuxtLink to="/" class="tg-back">返回搜索首页</NuxtLink>
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
          只填写频道用户名，例如 <code>my_channel</code> 或
          <code>@my_channel</code>，不会接受 URL。
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
            <p>来自 <code>config/channels.json</code>，已去重</p>
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
              title="只调试当前选中的频道"
            >
              {{ running[selectedChannel] ? "调试中…" : "单个调试" }}
            </button>
          </div>
          <div class="tg-detail-body">
            <div class="tg-detail-meta">
              <div>
                <span>测试关键词</span><strong>{{ keyword || "—" }}</strong>
              </div>
              <div>
                <span>请求入口</span
                ><strong>t.me/s/{{ selectedChannel }}</strong>
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
              还没有测试记录。点击右上角“单个调试”，或使用上方“测试全部频道”。
            </div>
            <section v-if="selectedReport" class="tg-debug-panel">
              <div class="tg-debug-panel-head">
                <div>
                  <h3>单个调试报文</h3>
                  <p>展示本次诊断接口入参、出参，以及实际访问上游的原始请求和响应。</p>
                </div>
                <span>{{ selectedReport.attempts.length }} 次上游请求</span>
              </div>
              <div class="tg-debug-grid">
                <div class="tg-debug-block">
                  <div class="tg-debug-block-head">
                    <strong>接口入参</strong><span>POST /api/tg/probe</span>
                  </div>
                  <pre>{{ formatJson(selectedInput) }}</pre>
                </div>
                <div class="tg-debug-block">
                  <div class="tg-debug-block-head">
                    <strong>接口出参</strong><span>JSON</span>
                  </div>
                  <pre>{{ formatJson(structuredOutput(selectedReport)) }}</pre>
                </div>
              </div>
              <div class="tg-debug-grid">
                <div class="tg-debug-block">
                  <div class="tg-debug-block-head">
                    <strong>上游原始请求</strong><span>{{ selectedReport.upstreamRequest?.method || "—" }}</span>
                  </div>
                  <pre>{{ formatJson(selectedReport.upstreamRequest) }}</pre>
                </div>
                <div class="tg-debug-block">
                  <div class="tg-debug-block-head">
                    <strong>上游原始响应</strong><span>HTTP {{ selectedReport.upstreamResponse?.status ?? "—" }}</span>
                  </div>
                  <div class="tg-raw-meta">
                    <span>正文 {{ selectedReport.upstreamResponse?.bodyLength ?? 0 }} 字符</span>
                    <span v-if="selectedReport.upstreamResponse?.bodyTruncated">已截断至 30,000 字符</span>
                  </div>
                  <pre class="tg-raw-body">{{ selectedReport.upstreamResponse?.body || "无响应正文" }}</pre>
                </div>
              </div>
              <details v-if="selectedReport.attempts.length > 1" class="tg-attempts">
                <summary>查看全部上游尝试（{{ selectedReport.attempts.length }}）</summary>
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
                :key="item.unique_id"
              >
                <strong>{{ item.title || "无标题" }}</strong>
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
import channelsConfig from "../config/channels.json";
import type { TgProbeResult } from "../server/core/services/tg";
useHead({
  title: "Telegram 频道测试",
  meta: [{ name: "robots", content: "noindex, nofollow" }],
});

type StateFilter = "all" | "available" | "warning" | "error" | "untested";
const configuredChannels = Array.from(
  new Set([
    ...channelsConfig.priorityChannels,
    ...channelsConfig.defaultChannels,
  ]),
);
const extraChannels = ref<string[]>([]);
const channels = computed(() =>
  Array.from(new Set([...configuredChannels, ...extraChannels.value])),
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
function stateOf(channel: string): StateFilter {
  return reports.value[channel]?.state || "untested";
}
function state(channel: string) {
  return stateOf(channel);
}
function stateLabel(channel: string) {
  return {
    available: "可用",
    warning: "待确认",
    error: "异常",
    untested: "未测试",
  }[stateOf(channel)];
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

function showNotice(message: string) {
  notice.value = message;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = ""), 4000);
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
    showNotice(error?.data?.statusMessage || error?.message || "测试请求失败");
  } finally {
    running.value[channel] = false;
  }
}
async function testCustom() {
  const channel = customChannel.value.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{5,64}$/.test(channel)) {
    showNotice("请输入公开频道用户名，不要填写 URL。");
    return;
  }
  if (!channels.value.includes(channel)) extraChannels.value.push(channel);
  selectedChannel.value = channel;
  customChannel.value = "";
  await testChannel(channel);
}
async function testAll() {
  if (runningCount.value || !keyword.value.trim()) return;
  const pending = filteredChannels.value;
  for (const channel of pending) await testChannel(channel);
  showNotice(`已完成 ${pending.length} 个频道测试`);
}
function clearReports() {
  reports.value = {};
  requestInputs.value = {};
  showNotice("已清除频道测试记录");
}
onBeforeUnmount(() => {
  if (noticeTimer) clearTimeout(noticeTimer);
});
</script>

<style scoped>
.tg-test-page {
  max-width: 1380px;
  margin: 0 auto;
  padding: 36px 26px 50px;
  color: #21312c;
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
  color: #7c9388;
  margin: 0 0 8px;
}
.tg-head h1 {
  font-size: 28px;
  letter-spacing: -0.6px;
  margin: 0;
}
.tg-subtitle {
  font-size: 12px;
  color: #7c8b83;
  margin: 8px 0 0;
}
.tg-back {
  border: 1px solid #dfe8e2;
  border-radius: 7px;
  background: #fff;
  padding: 9px 13px;
  color: #477060;
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
  border: 1px solid #e5ece7;
  border-radius: 10px;
  margin-bottom: 14px;
}
.tg-controls label {
  flex: 1;
}
.tg-controls label span,
.tg-custom > div strong {
  display: block;
  color: #627b6d;
  font-size: 10px;
  margin-bottom: 7px;
}
.tg-controls input,
.tg-controls select,
.tg-custom input {
  height: 39px;
  border: 1px solid #dce6e0;
  border-radius: 6px;
  padding: 0 11px;
  background: #fff;
  color: #2a4236;
  outline: none;
  width: 100%;
  font: 12px inherit;
}
.tg-controls input:focus,
.tg-controls select:focus,
.tg-custom input:focus {
  border-color: #72b39a;
  box-shadow: 0 0 0 3px #72b39a18;
}
.limit-field {
  max-width: 150px;
}
.tg-button {
  height: 39px;
  border-radius: 6px;
  padding: 0 14px;
  border: 1px solid #dce6e0;
  background: #fff;
  color: #4f6d5d;
  font-size: 11px;
  white-space: nowrap;
}
.tg-button.primary {
  background: #198463;
  border-color: #198463;
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
  color: #8a9a91;
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
  color: #977834;
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
  border: 1px solid #e5ece7;
  border-radius: 9px;
  padding: 15px 17px;
}
.tg-summary span {
  display: block;
  color: #829187;
  font-size: 10px;
}
.tg-summary strong {
  font-size: 24px;
  margin-top: 8px;
  display: block;
}
.tg-summary strong.green {
  color: #198463;
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
  border: 1px solid #e5ece7;
  border-radius: 10px;
  overflow: hidden;
}
.tg-card-head,
.tg-detail-head {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 20px;
  border-bottom: 1px solid #edf2ee;
}
.tg-card-head h2,
.tg-detail-head h2 {
  font-size: 14px;
  margin: 0;
}
.tg-card-head p,
.tg-detail-head p {
  font-size: 10px;
  color: #8c9c92;
  margin: 4px 0 0;
}
.tg-card-head > span {
  margin-left: auto;
  color: #a0afa5;
  font:
    9px ui-monospace,
    monospace;
}
.tg-filter {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 14px 17px;
  border-bottom: 1px solid #edf2ee;
  flex-wrap: wrap;
}
.tg-filter button {
  border: 0;
  background: #f4f7f5;
  color: #829087;
  border-radius: 4px;
  padding: 7px 8px;
  font-size: 10px;
}
.tg-filter button.active {
  background: #e8f5ee;
  color: #18765a;
  font-weight: 600;
}
.tg-filter button small {
  margin-left: 4px;
}
.tg-filter input {
  margin-left: auto;
  width: 135px;
  height: 30px;
  border: 1px solid #e1e9e4;
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
  border-bottom: 1px solid #f0f3f1;
  background: #fff;
  color: #253b30;
}
.tg-channel-row:hover {
  background: #f8fbf9;
}
.tg-channel-row.selected {
  background: #eff8f3;
  box-shadow: inset 3px 0 #198463;
}
.tg-channel-avatar {
  display: grid;
  place-items: center;
  width: 31px;
  height: 31px;
  flex: 0 0 31px;
  border-radius: 8px;
  background: #eef6f1;
  color: #208363;
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
  color: #9aa8a0;
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
  color: #89988f;
  background: #f4f6f5;
  padding: 4px 6px;
  border-radius: 4px;
  font-size: 9px;
  white-space: nowrap;
}
.tg-state i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #abb7b0;
}
.tg-state.available {
  background: #eaf7ef;
  color: #288a69;
}
.tg-state.available i {
  background: #299c74;
}
.tg-state.warning {
  background: #fff7e8;
  color: #ae8b3f;
}
.tg-state.warning i {
  background: #d3a344;
}
.tg-state.error {
  background: #fff0ef;
  color: #bc6c66;
}
.tg-state.error i {
  background: #d86b65;
}
.tg-latency {
  width: 61px;
  text-align: right;
  color: #8b9a92;
  font:
    9px ui-monospace,
    monospace;
}
.tg-empty {
  text-align: center;
  padding: 44px;
  color: #9aa79f;
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
  color: #368367;
  border: 1px solid #d6eadd;
  border-radius: 3px;
  padding: 2px 4px;
  vertical-align: middle;
}
.tg-icon-button {
  border: 0;
  background: transparent;
  color: #718b7d;
  font-size: 22px;
  min-width: 36px;
  min-height: 36px;
  border-radius: 6px;
}
.tg-icon-button:hover:not(:disabled) {
  background: #eef6f1;
  color: #198463;
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
  background: #f8faf9;
  border: 1px solid #e9efeb;
  border-radius: 6px;
  padding: 11px;
}
.tg-detail-meta span {
  display: block;
  font-size: 9px;
  color: #93a097;
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
  background: #eef9f3;
  border: 1px solid #d8eddf;
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
  background: #a2b0a8;
}
.tg-result-box.available .tg-result-title i {
  background: #269b71;
}
.tg-result-box.warning .tg-result-title i {
  background: #d3a146;
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
  color: #80948a;
}
.tg-result-box p {
  font-size: 9px;
  color: #8b9a91;
  margin: 8px 0 0;
}
.tg-placeholder {
  border: 1px dashed #dbe6df;
  border-radius: 7px;
  padding: 42px 18px;
  text-align: center;
  color: #8e9d94;
  font-size: 11px;
  margin-bottom: 20px;
}
.tg-results {
  border-top: 1px solid #e9efeb;
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
  color: #8aa092;
}
.tg-results article {
  padding: 11px 0;
  border-bottom: 1px solid #f0f3f1;
}
.tg-results article strong {
  font-size: 11px;
}
.tg-results article p {
  font:
    9px/1.8 ui-monospace,
    monospace;
  color: #84958a;
  margin: 4px 0 0;
  overflow-wrap: anywhere;
}
.tg-debug-panel {
  margin: 20px 0;
  border: 1px solid #dce8e0;
  border-radius: 8px;
  background: #fbfdfc;
  overflow: hidden;
}
.tg-debug-panel-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
  padding: 14px;
  border-bottom: 1px solid #e8efea;
}
.tg-debug-panel-head h3 {
  margin: 0;
  font-size: 12px;
}
.tg-debug-panel-head p {
  margin: 5px 0 0;
  color: #87988e;
  font-size: 9px;
}
.tg-debug-panel-head > span,
.tg-debug-block-head span,
.tg-attempt-head span {
  color: #8a9c91;
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
  border: 1px solid #e5ece7;
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
  background: #f5f9f6;
  border-bottom: 1px solid #e8efea;
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
  color: #456056;
  font: 9px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.tg-debug-block .tg-raw-body {
  max-height: 360px;
  white-space: pre-wrap;
  color: #526d60;
}
.tg-raw-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 7px 10px 0;
  color: #9a8a5e;
  font-size: 9px;
}
.tg-attempts {
  margin: 12px 14px 14px;
  border: 1px solid #e5ece7;
  border-radius: 6px;
  overflow: hidden;
  background: #fff;
}
.tg-attempts summary {
  cursor: pointer;
  padding: 10px;
  color: #527263;
  font-size: 10px;
  background: #f5f9f6;
}
.tg-attempt {
  border-top: 1px solid #e8efea;
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
  background: #f7faf8;
  border-radius: 7px;
  padding: 13px;
  color: #7f9487;
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
  color: #9ba89f;
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
</style>
