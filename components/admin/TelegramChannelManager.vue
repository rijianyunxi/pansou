<template>
  <section class="sources-panel tg-manager" aria-label="TG 频道管理">
    <header class="tg-manager-header">
      <div>
        <h2>Telegram 插件</h2>
        <p>每个频道都是一个请求 + transform 插件。</p>
      </div>
      <span class="field-hint">请求配置与 transform 可在频道行展开</span>
    </header>
    <div class="manager-body">
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <p v-if="loading" role="status">正在读取服务端频道配置…</p>
      <template v-else-if="loaded">
        <div class="tg-master">
          <label class="tg-master-switch">
            <button class="toggle" :class="{ on: systemEnabled }" type="button" role="switch" :aria-checked="systemEnabled" :disabled="saving" aria-label="TG 参与本站搜索" @click="toggleSystem"><span></span></button>
            <div><strong>TG 参与本站搜索</strong><small>关闭后本站搜索不再追加已配置频道；不影响用户搜索个人频道。</small></div>
          </label>
        </div>
        <div class="tg-stat-strip" aria-label="频道概览">
          <div class="tg-stat-card">
            <span>频道总数</span>
            <strong>{{ displayed.length }}</strong>
            <small>配置目录</small>
          </div>
          <div class="tg-stat-card is-green">
            <span>健康可用</span>
            <strong>{{ healthyCount }}</strong>
            <small>最近一次监控</small>
          </div>
          <div class="tg-stat-card is-amber">
            <span>待确认</span>
            <strong>{{ warningCount }}</strong>
            <small>需要人工复核</small>
          </div>
          <div class="tg-stat-card is-muted">
            <span>未检测</span>
            <strong>{{ untestedCount }}</strong>
            <small>等待首次检测</small>
          </div>
        </div>
        <p class="field-hint tg-effective-hint">当前已生效 {{ effectiveCountText }} 个 · 修改立即生效。</p>
        <details class="tg-source-settings">
          <summary>请求配置</summary>
          <div class="editor-grid">
            <label>直连地址模板<input v-model="sourceDraft.directTemplate" placeholder="https://t.me/s/{{channel}}" /></label>
            <label>Jina 地址模板<input v-model="sourceDraft.jinaTemplate" placeholder="https://r.jina.ai/https://t.me/s/{{channel}}" /></label>
            <label>请求 User-Agent<input v-model="sourceDraft.userAgent" maxlength="300" /></label>
            <label class="tg-headers-field">请求 Headers（JSON）<textarea v-model="sourceHeadersText" rows="3" spellcheck="false" placeholder='{"user-agent":"Mozilla/5.0"}' /></label>
          </div>
          <div class="mapping-actions"><button class="button secondary small" type="button" :disabled="sourceSaving" @click="saveSourceSettings">{{ sourceSaving ? '保存中…' : '保存抓取来源' }}</button><span class="field-hint">模板、Headers 和全局 transform 保存后下一次请求立即生效。</span></div>
        </details>
        <form class="tg-add" @submit.prevent="addChannel">
          <label for="system-channel">新增公开频道</label>
          <div><input id="system-channel" v-model="newChannel" :disabled="saving" placeholder="@用户名 或 t.me/s/公开频道链接" autocomplete="off" /><button class="button secondary" :disabled="saving || !newChannel.trim()">添加频道</button></div>
          <p class="field-hint">最多 200 个。</p>
        </form>
        <div class="tg-list-toolbar">
          <div class="tg-list-title">
            <strong>频道目录</strong>
            <span>{{ visibleChannels.length }} / {{ displayed.length }}</span>
          </div>
          <div class="tg-toolbar-right">
            <label class="tg-search-field"><span>筛选</span> <input v-model="channelSearch" aria-label="筛选频道" maxlength="100" placeholder="搜索频道…" /></label>
            <label><span>检测关键词</span> <input v-model="keyword" aria-label="频道检测关键词" maxlength="100" placeholder="三体" /></label>
            <button class="button secondary" type="button" :disabled="saving || !systemListExplicit" @click="restoreDefaults">恢复默认配置</button>
            <button class="button secondary" type="button" :disabled="batchRunning || !!running || !keyword.trim()" aria-label="批量检测频道" @click="batchProbe">{{ batchRunning ? `检测中 ${batchProgress}/${batchTotal}` : '批量检测' }}</button>
            <button class="text-button" type="button" :disabled="monitorLoading" aria-label="刷新频道健康摘要" @click="loadMonitorSummary">{{ monitorLoading ? '刷新中…' : '刷新监控' }}</button>
          </div>
        </div>
        <div class="tg-rows">
          <div v-for="channel in visibleChannels" :key="channel" class="tg-item" :class="{ 'tg-item-off': overrideLabel(channel) }">
            <div class="tg-row">
              <div class="tg-channel">
                <div class="tg-channel-name">
                  <strong>@{{ channel }}</strong>
                  <span class="tg-origin" :class="originOf(channel) === 'custom' ? 'custom' : ''">{{ originOf(channel) === 'custom' ? '手动添加' : '默认配置' }}</span>
                  <span v-if="overrideLabel(channel)" class="tg-flag" :class="overrideLabel(channel) === '已删除' ? 'off' : 'warn'">{{ overrideLabel(channel) }}</span>
                </div>
                <small class="tg-health"><span class="status-dot" :class="healthTone(channel)"></span>{{ rowSummary(channel) }}</small>
              </div>
              <div class="tg-row-actions"><label class="tg-parser-inline"><span>解析函数</span><select :value="parserBindings[channel] || ''" :disabled="parserSaving === channel || saving || batchRunning" :aria-label="`选择 ${channel} 的解析函数`" @change="onParserChange(channel, $event)"><option value="">使用默认函数</option><option v-for="plugin in telegramParsers" :key="plugin.id" :value="plugin.id">{{ plugin.name }} · {{ plugin.manifest.version }}</option></select></label><span v-if="parserSaving === channel" class="field-hint">保存中…</span><button type="button" class="button secondary small" :disabled="!!running || batchRunning || !keyword.trim()" :aria-label="`检测 ${channel}`" @click="probe(channel)">{{ running === channel ? '检测中…' : '检测' }}</button><button type="button" class="button secondary small" :disabled="batchRunning" :aria-label="`调试报文 ${channel}`" @click="debugChannel = channel">调试报文</button><button type="button" class="button secondary small" :disabled="batchRunning || saving" :aria-label="`抓取策略 ${channel}`" @click="togglePolicy(channel)">策略{{ hasPolicyDraft(channel) ? ' ·' : '' }}</button><button type="button" class="button secondary small" :disabled="batchRunning || saving" :aria-label="`编辑 transform ${channel}`" @click="toggleFunction(channel)">函数{{ functionEditorFor === channel ? ' ·' : '' }}</button><button type="button" class="button secondary small" :disabled="monitorBusy === channel || saving || batchRunning" :aria-label="`${overrideActionLabel(channel)}频道 ${channel}`" @click="toggleOverride(channel)">{{ monitorBusy === channel ? '处理中…' : overrideActionLabel(channel) }}</button><button type="button" class="button danger-button small" :disabled="monitorBusy === channel || saving || batchRunning" :aria-label="`删除频道 ${channel}`" @click="deleteChannelRow(channel)">删除</button></div>
            </div>
            <div v-if="policyEditorFor === channel" class="tg-policy">
              <label><span>超时 ms</span><input v-model="policyDraft[channel]!.timeoutMs" inputmode="numeric" placeholder="默认" /></label>
              <label><span>抓取页数</span><input v-model="policyDraft[channel]!.maxPages" inputmode="numeric" placeholder="默认" /></label>
              <label><span>结果上限</span><input v-model="policyDraft[channel]!.maxResults" inputmode="numeric" placeholder="默认" /></label>
              <label><span>Fallback</span><select v-model="policyDraft[channel]!.fallback" aria-label="抓取 fallback 策略"><option value="">先直连后 Jina</option><option value="direct">仅直连</option><option value="jina">仅 Jina</option></select></label>
              <div class="tg-policy-actions">
                <button class="button secondary" type="button" :disabled="saving" @click="savePolicy(channel)">{{ saving ? '保存中…' : '保存策略' }}</button>
                <button class="text-button" type="button" @click="policyEditorFor = ''">收起</button>
              </div>
              <p class="field-hint">留空使用全局默认。范围：超时 1000–120000ms、页数 1–50、结果数 1–200。</p>
            </div>
            <div v-if="functionEditorFor === channel" class="tg-function-editor">
              <div class="tg-function-request">
                <strong>请求配置</strong>
                <span>GET · HTML</span>
                <code>{{ directUrlFor(channel) }}</code>
                <code>Headers: {{ Object.keys(sourceDraft.headers || {}).length ? JSON.stringify(sourceDraft.headers) : "默认" }}</code>
              </div>
              <label class="tg-transform-field">
                <span class="function-label-line"><span>transform(payload, $, context)</span><span class="function-file-actions"><button type="button" class="text-button" :disabled="functionSaving" @click="openTransformImport">导入 JS</button><button type="button" class="text-button" :disabled="!functionDraft.transform.trim()" @click="exportTransform(channel)">导出 JS</button></span></span>
                <textarea v-model="functionDraft.transform" rows="9" spellcheck="false" :disabled="functionSaving" placeholder="编辑 transform(payload, $, context)" />
                <input ref="transformImportInput" class="transform-file" type="file" accept=".js,.mjs,text/javascript" @change="importTransform" />
              </label>
              <div class="tg-function-actions">
                <span class="field-hint">{{ parserBindings[channel] ? `当前绑定：${parserBindings[channel]}；保存会生成新版本并发布。` : "当前使用全局 TG transform；保存会更新所有未绑定频道。" }}</span>
                <button class="button secondary small" type="button" :disabled="functionSaving || !functionDraft.transform.trim()" @click="saveFunction(channel)">{{ functionSaving ? "保存中…" : "保存函数" }}</button>
              </div>
            </div>
          </div>
          <p v-if="!visibleChannels.length" class="tg-empty">{{ displayed.length ? '没有匹配的频道，请换一个筛选词。' : '还没有配置频道。可新增公开频道，或恢复默认配置。' }}</p>
        </div>
        <div class="tg-io" aria-label="频道批量导入导出">
          <div class="tg-io-actions">
            <button class="button secondary" type="button" :disabled="ioBusy" @click="exportChannels">{{ ioBusy && ioAction === 'export' ? '导出中…' : '导出配置 JSON' }}</button>
            <button class="button secondary" type="button" :disabled="ioBusy" @click="fileInput?.click()">{{ ioBusy && ioAction === 'file' ? '导入中…' : '从文件导入' }}</button>
            <button class="button secondary" type="button" :disabled="ioBusy" @click="togglePasteImport">粘贴导入</button>
            <input ref="fileInput" class="tg-io-file" type="file" accept="application/json,.json,text/plain" @change="onImportFile" />
            <span v-if="ioMessage" class="tg-io-message" role="status">{{ ioMessage }}</span>
            <span v-else-if="ioError" class="tg-io-error" role="alert">{{ ioError }}</span>
          </div>
          <div v-if="showPasteImport" class="tg-io-paste">
            <textarea v-model="pasteText" rows="6" spellcheck="false" aria-label="粘贴导入 JSON" placeholder='粘贴导出的 JSON，例如 {"channels": ["xxx"], "policies": {"xxx": {"timeoutMs": 10000}}}。缺省键不修改，null 重置。'></textarea>
            <div class="tg-io-paste-actions">
              <button class="button primary" type="button" :disabled="ioBusy || !pasteText.trim()" @click="importFromText">{{ ioBusy && ioAction === 'paste' ? '导入中…' : '确认导入' }}</button>
              <button class="button secondary" type="button" :disabled="ioBusy" @click="closePasteImport">收起</button>
            </div>
            <p class="field-hint">导入直接覆盖服务端已保存的频道清单和/或策略，并重载本面板；格式非法时服务端返回 400 且现有配置不变。</p>
          </div>
        </div>
        <span v-if="message" role="status">{{ message }}</span>
      </template>
      <button v-if="!loaded && !loading" class="button secondary" type="button" @click="load">重新加载</button>
    </div>
    <TelegramDebugDrawer v-if="debugChannel" :key="debugChannel" :channel="debugChannel" :initial-keyword="keyword" :report="reports[debugChannel]" :request="requests[debugChannel]" :error="probeErrors[debugChannel]" :busy="!!running" :running="running === debugChannel" :source-settings="sourceDraft" @close="debugChannel = ''" @run="probe(debugChannel, $event)" />
  </section>
</template>
<script setup lang="ts">
import TelegramDebugDrawer from "./TelegramDebugDrawer.vue";
import { parseTelegramChannelInput } from "../../utils/telegramChannelInput";
import type { TgProbeResult } from "../../server/core/services/tg";
import type { TgChannelPolicy } from "../../server/utils/telegramSettings";
type ChannelPolicy = TgChannelPolicy;
const props = defineProps<{ focusChannel?: string | null }>();
type PolicyDraft = { timeoutMs: string; maxPages: string; maxResults: string; fallback: "" | "direct" | "jina" };
type Settings = { channels: string[] | null; defaultChannels: string[]; effectiveChannels: string[]; policies?: Record<string, ChannelPolicy> };
type TgSourceSettings = { directTemplate: string; jinaTemplate: string; userAgent: string; headers: Record<string, string>; transform: string; parserVersion: string };
type ParserPlugin = { id: string; name: string; code?: string; status: string; manifest: { id?: string; name?: string; version: string; description?: string; format: "html" | "json" | "text" | "auto"; target: "upstream" | "telegram" | "both"; timeoutMs?: number; maxResults?: number } };
const emit = defineEmits<{ (event: "unauthorized"): void }>();
const loading = ref(true), loaded = ref(false), saving = ref(false);
const saved = ref<Settings>({ channels: null, defaultChannels: [], effectiveChannels: [], policies: {} });
const sourceDraft = reactive<TgSourceSettings>({ directTemplate: "", jinaTemplate: "", userAgent: "", headers: {}, transform: "", parserVersion: "" });
const sourceHeadersText = ref("{}");
const sourceSaving = ref(false);
const newChannel = ref(""), keyword = ref("三体"), channelSearch = ref(""), error = ref(""), message = ref(""), running = ref("");
const reports = ref<Record<string, TgProbeResult>>({});
const debugChannel = ref("");
const requests = ref<Record<string, { channel: string; keyword: string; limit: number }>>({});
const probeErrors = ref<Record<string, string>>({});
const policyDraft = ref<Record<string, PolicyDraft>>({});
const policyEditorFor = ref("");
let probeController: AbortController | undefined;
let disposed = false;
/** ---- 每频道覆盖状态与健康摘要（/api/monitor 与频道动作端点，即时生效） ---- */
type ChannelOverride = { enabled: boolean; deleted: boolean };
type MonitorChannelEntry = {
  channel?: string;
  enabled?: boolean;
  deleted?: boolean;
  health?: { state?: string; failureKind?: string | null; elapsedMs?: number | null; resultsCount?: number | null; message?: string | null } | null;
};
const overrides = ref<Record<string, ChannelOverride>>({});
const channelHealth = ref<Record<string, { state: string; elapsedMs: number | null; resultsCount: number | null; message: string; failureKind: string } | null>>({});
const monitorBusy = ref(""), monitorLoading = ref(false);
const batchRunning = ref(false), batchProgress = ref(0), batchTotal = ref(0);
const parserBindings = ref<Record<string, string>>({});
const telegramParsers = ref<ParserPlugin[]>([]);
const parserSaving = ref("");
const functionEditorFor = ref("");
const functionDraft = reactive({ transform: "" });
const functionSaving = ref(false);
const transformImportInput = ref<HTMLInputElement | null>(null);
const systemEnabled = computed(() => saved.value.channels === null || saved.value.channels.length > 0);
const systemListExplicit = computed(() => saved.value.channels !== null);
const effectivePool = computed(() => (saved.value.channels === null ? saved.value.defaultChannels : saved.value.channels));
const effectiveCountText = computed(() => effectivePool.value.filter((name) => {
  const override = overrides.value[name];
  return !override || (!override.deleted && override.enabled !== false);
}).length);
const displayed = computed(() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of [...saved.value.defaultChannels, ...(saved.value.channels ?? []), ...Object.keys(overrides.value)]) {
    if (!seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
});
const visibleChannels = computed(() => {
  const query = channelSearch.value.trim().toLowerCase();
  if (!query) return displayed.value;
  return displayed.value.filter((channel) => channel.toLowerCase().includes(query));
});
const healthyCount = computed(() => displayed.value.filter((channel) => healthTone(channel) === "available").length);
const warningCount = computed(() => displayed.value.filter((channel) => healthTone(channel) === "warning").length);
const untestedCount = computed(() => displayed.value.filter((channel) => healthTone(channel) === "neutral").length);
function overrideOf(channel: string): ChannelOverride {
  const override = overrides.value[channel];
  return { enabled: override?.enabled !== false, deleted: override?.deleted === true };
}
function overrideLabel(channel: string): string {
  const override = overrideOf(channel);
  if (override.deleted) return "已删除";
  if (!override.enabled) return "已停用";
  return "";
}
function overrideActionLabel(channel: string): string {
  const override = overrideOf(channel);
  return override.deleted || !override.enabled ? "启用" : "停用";
}
function originOf(channel: string): "builtin" | "custom" {
  return saved.value.defaultChannels.includes(channel) ? "builtin" : "custom";
}
function rowSummary(channel: string): string {
  const report = reports.value[channel];
  if (report) return `${stateText(report.state)} · ${report.elapsedMs} ms · ${report.results.length} 条`;
  if (probeErrors.value[channel]) return "最近请求失败 · 打开调试查看详情";
  const health = channelHealth.value[channel];
  if (health && health.state !== "unknown") {
    const label = ({ available: "可用", warning: "需确认", error: "异常" } as Record<string, string>)[health.state] || health.state;
    const parts = [`监控：${label}`];
    if (health.elapsedMs != null) parts.push(`${health.elapsedMs} ms`);
    if (health.resultsCount != null) parts.push(`${health.resultsCount} 条`);
    if (health.failureKind && health.state !== "available") parts.push(health.failureKind);
    return parts.join(" · ");
  }
  return "未检测 · 添加不代表可访问";
}
function healthTone(channel: string): string {
  const state = channelHealth.value[channel]?.state;
  if (state === "available") return "available";
  if (state === "warning") return "warning";
  if (state === "error") return "error";
  return "neutral";
}
/** 批量检测：顺序执行（探测接口限 2 并发），跳过已停用/已删除频道。 */
async function batchProbe() {
  if (batchRunning.value || running.value || !keyword.value.trim()) return;
  const targets = displayed.value.filter((channel) => !overrideLabel(channel));
  if (!targets.length) { message.value = "没有可检测的频道（已停用/已删除的会被跳过）。"; return; }
  batchRunning.value = true; error.value = ""; batchTotal.value = targets.length; batchProgress.value = 0;
  let responded = 0;
  try {
    for (const channel of targets) {
      if (disposed) break;
      await probe(channel);
      batchProgress.value += 1;
      if (reports.value[channel]) responded += 1;
    }
    message.value = `批量检测完成：${responded}/${targets.length} 个频道可访问。`;
  } finally { if (!disposed) batchRunning.value = false; }
}
async function loadParserSettings() {
  try {
    const [bindingResponse, pluginResponse] = await Promise.all([
      $fetch<{ data?: { telegram?: Record<string, { pluginId?: string | null }> } }>("/api/settings/parser-bindings"),
      $fetch<{ data?: ParserPlugin[] }>("/api/parser-plugins"),
    ]);
    parserBindings.value = Object.fromEntries(Object.entries(bindingResponse.data?.telegram ?? {}).flatMap(([channel, binding]) => binding?.pluginId ? [[channel, binding.pluginId]] : []));
    telegramParsers.value = (pluginResponse.data ?? []).filter((plugin) => plugin.status === "published" && (plugin.manifest.target === "telegram" || plugin.manifest.target === "both") && (plugin.manifest.format === "html" || plugin.manifest.format === "text" || plugin.manifest.format === "auto"));
    syncFocusedFunction();
  } catch { /* parser management is additive; channel management remains usable */ }
}
async function onParserChange(channel: string, event: Event) {
  const pluginId = (event.target as HTMLSelectElement).value;
  parserSaving.value = channel; error.value = "";
  try {
    await $fetch("/api/settings/parser-bindings", { method: "PUT", body: { scope: "telegram", id: channel, pluginId } });
    const next = { ...parserBindings.value };
    if (pluginId) next[channel] = pluginId; else delete next[channel];
    parserBindings.value = next;
    message.value = `@${channel} 的解析函数已更新，下一次请求立即生效。`;
  } catch (reason: any) { fail(reason); }
  finally { parserSaving.value = ""; }
}
function openTransformImport() { transformImportInput.value?.click(); }
function exportTransform(channel: string) {
  const blob = new Blob([functionDraft.transform], { type: "text/javascript;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = `tg-${channel}-transform.js`;
  document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
}
async function importTransform(event: Event) {
  const input = event.target as HTMLInputElement; const file = input.files?.[0]; input.value = "";
  if (!file) return;
  const code = await file.text();
  if (code.trim()) { functionDraft.transform = code; error.value = ""; }
}
const CHANNEL_TOKEN = "{{channel}}";
function directUrlFor(channel: string): string {
  return sourceDraft.directTemplate.replaceAll(CHANNEL_TOKEN, channel);
}
function parserById(id: string) {
  return telegramParsers.value.find((plugin) => plugin.id === id);
}
function toggleFunction(channel: string) {
  if (functionEditorFor.value === channel) {
    functionEditorFor.value = "";
    return;
  }
  functionEditorFor.value = channel;
  const parserId = parserBindings.value[channel];
  functionDraft.transform = parserId && parserById(parserId)?.code
    ? parserById(parserId)!.code!
    : sourceDraft.transform || "function transform(payload, $, context) {\n  return [];\n}";
}
function syncFocusedFunction() {
  const focus = String(props.focusChannel || "").replace(/^@/, "").toLowerCase();
  if (!focus || !displayed.value.includes(focus)) return;
  channelSearch.value = focus;
  functionEditorFor.value = focus;
  const parserId = parserBindings.value[focus];
  functionDraft.transform = parserId && parserById(parserId)?.code
    ? parserById(parserId)!.code!
    : sourceDraft.transform || "function transform(payload, $, context) {\n  return [];\n}";
}
function nextPatchVersion(version: string) {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) return "1.0.1";
  const [major, minor, patch] = parts;
  if (major === undefined || minor === undefined || patch === undefined) return "1.0.1";
  return `${major}.${minor}.${patch + 1}`;
}
async function saveFunction(channel: string) {
  if (!functionDraft.transform.trim()) return;
  functionSaving.value = true;
  error.value = "";
  try {
    const parserId = parserBindings.value[channel];
    const parser = parserId ? parserById(parserId) : undefined;
    if (parserId && parser) {
      const manifest = { ...parser.manifest, id: parser.id, name: parser.name, version: nextPatchVersion(parser.manifest.version) };
      await $fetch(`/api/parser-plugins/${parser.id}`, { method: "PUT", body: { plugin: { manifest, code: functionDraft.transform } } });
      await $fetch(`/api/parser-plugins/${parser.id}/publish`, { method: "POST" });
      await loadParserSettings();
      message.value = `@${channel} 的 transform 已保存并发布。`;
    } else {
      const response = await $fetch<{ data: TgSourceSettings }>("/api/settings/tg-source/transform", {
        method: "PUT",
        body: { transform: functionDraft.transform },
      });
      Object.assign(sourceDraft, response.data);
      message.value = `TG 全局 transform 已保存，@${channel} 等未绑定频道下一次请求立即生效。`;
    }
  } catch (reason: any) {
    fail(reason);
  } finally {
    functionSaving.value = false;
  }
}

async function loadMonitorSummary() {
  if (monitorLoading.value) return;
  monitorLoading.value = true;
  try {
    const response = await $fetch<{ data?: { channels?: MonitorChannelEntry[] } }>("/api/monitor");
    const entries = response.data?.channels ?? [];
    const nextOverrides: Record<string, ChannelOverride> = {};
    const nextHealth: typeof channelHealth.value = {};
    for (const entry of entries) {
      const name = String(entry?.channel || "").replace(/^@/, "").trim();
      if (!name) continue;
      nextOverrides[name] = { enabled: entry.enabled !== false, deleted: entry.deleted === true };
      nextHealth[name] = {
        state: String(entry.health?.state || "unknown"),
        elapsedMs: typeof entry.health?.elapsedMs === "number" ? entry.health.elapsedMs : null,
        resultsCount: typeof entry.health?.resultsCount === "number" ? entry.health.resultsCount : null,
        message: String(entry.health?.message || ""),
        failureKind: String(entry.health?.failureKind || ""),
      };
    }
    overrides.value = nextOverrides;
    channelHealth.value = nextHealth;
  } catch { /* 静默降级：无监控数据时行内显示"未检测" */ }
  finally { if (!disposed) monitorLoading.value = false; }
}
async function toggleOverride(channel: string) {
  if (monitorBusy.value || saving.value) return;
  const current = overrideOf(channel);
  const enable = current.deleted || !current.enabled;
  monitorBusy.value = channel; error.value = ""; message.value = "";
  try {
    const response = await $fetch<{ code?: number; message?: string; data?: { enabled?: boolean; deleted?: boolean } }>(
      `/api/tg/channels/${encodeURIComponent(channel)}/${enable ? "enable" : "disable"}`,
      { method: "POST" },
    );
    if ((response.code ?? 0) !== 0) { error.value = response.message || "操作未被接受。"; return; }
    overrides.value = { ...overrides.value, [channel]: { enabled: response.data?.enabled !== false, deleted: response.data?.deleted === true } };
    message.value = `@${channel} 已${enable ? "启用" : "停用"}，下一次本站搜索生效。`;
  } catch (reason: any) {
    if ((reason?.statusCode || reason?.response?.status) === 401) emit("unauthorized");
    error.value = reason?.data?.statusMessage || reason?.message || "操作失败，请重试。";
  } finally { monitorBusy.value = ""; }
}
async function deleteChannelRow(channel: string) {
  if (monitorBusy.value || saving.value) return;
  const isCustom = originOf(channel) === "custom";
  const tip = isCustom
    ? `彻底移除自定义频道 @${channel}？该操作立即生效并保存。`
    : `将频道 @${channel} 从生效清单移除？之后可随时启用恢复。`;
  if (!window.confirm(tip)) return;
  monitorBusy.value = channel; error.value = ""; message.value = "";
  try {
    const response = await $fetch<{ code?: number; message?: string; data?: { origin?: string } }>(
      `/api/tg/channels/${encodeURIComponent(channel)}`,
      { method: "DELETE" },
    );
    if ((response.code ?? 0) !== 0) { error.value = response.message || "删除未被接受。"; return; }
    if (response.data?.origin === "custom") {
      saved.value = { ...saved.value, channels: (saved.value.channels ?? []).filter((name) => name !== channel) };
      message.value = `@${channel} 已移除并保存，下一次本站搜索生效。`;
    } else {
      overrides.value = { ...overrides.value, [channel]: { enabled: overrideOf(channel).enabled, deleted: true } };
      message.value = `@${channel} 已从生效清单移除，可通过「启用」恢复。`;
    }
  } catch (reason: any) {
    if ((reason?.statusCode || reason?.response?.status) === 401) emit("unauthorized");
    error.value = reason?.data?.statusMessage || reason?.message || "删除失败，请重试。";
  } finally { monitorBusy.value = ""; }
}
const emptyDraft = (): PolicyDraft => ({ timeoutMs: "", maxPages: "", maxResults: "", fallback: "" });
function draftFromPolicies(policies: Record<string, ChannelPolicy> | undefined): Record<string, PolicyDraft> {
  const out: Record<string, PolicyDraft> = {};
  for (const [name, policy] of Object.entries(policies ?? {})) {
    out[name] = {
      timeoutMs: policy?.timeoutMs != null ? String(policy.timeoutMs) : "",
      maxPages: policy?.maxPages != null ? String(policy.maxPages) : "",
      maxResults: policy?.maxResults != null ? String(policy.maxResults) : "",
      fallback: policy?.fallback ?? "",
    };
  }
  return out;
}
function hasPolicyDraft(channel: string): boolean {
  const draft = policyDraft.value[channel];
  return !!draft && !!(draft.timeoutMs.trim() || draft.maxPages.trim() || draft.maxResults.trim() || draft.fallback);
}
function togglePolicy(channel: string) {
  if (!policyDraft.value[channel]) policyDraft.value[channel] = draftFromPolicies(saved.value.policies)[channel] || emptyDraft();
  policyEditorFor.value = policyEditorFor.value === channel ? "" : channel;
}
function stateText(state: string) { return ({ available: "可提取结果", warning: "需确认", error: "请求异常" } as Record<string, string>)[state] || state; }
function fail(reason: any) { if ((reason?.statusCode || reason?.response?.status) === 401) emit("unauthorized"); error.value = reason?.data?.statusMessage || reason?.message || "操作失败，请重试。"; }
async function loadSourceSettings() {
  try {
    const response = await $fetch<{ data: TgSourceSettings }>("/api/settings/tg-source");
    Object.assign(sourceDraft, response.data);
    sourceHeadersText.value = JSON.stringify(response.data.headers || {}, null, 2);
  } catch (reason) { fail(reason); }
}
async function saveSourceSettings() {
  if (sourceSaving.value) return;
  sourceSaving.value = true; error.value = "";
  try {
    let headers: Record<string, string> = {};
    if (sourceHeadersText.value.trim()) {
      const parsed = JSON.parse(sourceHeadersText.value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((value) => typeof value !== "string")) {
        throw new Error("Headers 必须是字符串键值 JSON。");
      }
      headers = parsed as Record<string, string>;
    }
    const response = await $fetch<{ data: TgSourceSettings }>("/api/settings/tg-source", { method: "PUT", body: { ...sourceDraft, headers } });
    Object.assign(sourceDraft, response.data);
    sourceHeadersText.value = JSON.stringify(response.data.headers || {}, null, 2);
    message.value = "TG 抓取来源已保存，下一次请求立即生效。";
  } catch (reason) { fail(reason); }
  finally { sourceSaving.value = false; }
}
async function load() { loading.value = true; error.value = ""; try { saved.value = (await $fetch<{ data: Settings }>("/api/settings/telegram")).data; loaded.value = true; policyDraft.value = draftFromPolicies(saved.value.policies); policyEditorFor.value = ""; error.value = ""; message.value = ""; await loadSourceSettings(); syncFocusedFunction(); } catch (reason) { fail(reason); } finally { loading.value = false; } }
/** 统一保存入口：写入频道清单（null = 默认配置）；可选同时写入策略映射。 */
async function saveChannels(channels: string[] | null, policies?: Record<string, ChannelPolicy>, successMessage = "已保存，下一次本站搜索生效。") {
  saving.value = true; error.value = "";
  try {
    const body: { channels: string[] | null; policies?: Record<string, ChannelPolicy> } = { channels };
    if (policies) body.policies = policies;
    saved.value = (await $fetch<{ data: Settings }>("/api/settings/telegram", { method: "PUT", body })).data;
    policyDraft.value = draftFromPolicies(saved.value.policies);
    policyEditorFor.value = "";
    message.value = successMessage;
    return true;
  } catch (reason: any) { fail(reason); return false; } finally { saving.value = false; }
}
async function addChannel() {
  const name = parseTelegramChannelInput(newChannel.value); error.value = ""; message.value = "";
  if (!name) { error.value = "请输入有效的公开频道用户名或链接，例如 @channel_name 或 t.me/s/channel_name；不支持私密邀请链接。"; return; }
  const base = saved.value.channels === null ? [...saved.value.defaultChannels] : [...saved.value.channels];
  if (base.includes(name)) { message.value = `@${name} 已在清单中。`; return; }
  if (base.length >= 200) { error.value = "最多添加 200 个配置频道。"; return; }
  if (await saveChannels([...base, name])) {
    newChannel.value = "";
    message.value = `@${name} 已添加并保存，下一次本站搜索生效。`;
  }
}
async function toggleSystem() {
  if (systemEnabled.value) {
    if (await saveChannels([])) message.value = "TG 已关闭，下一次本站搜索不再追加已配置频道。";
  } else if (await saveChannels([...saved.value.defaultChannels])) {
    message.value = "TG 已开启（默认配置），下一次本站搜索生效。";
  }
}
async function restoreDefaults() {
  if (await saveChannels(null)) message.value = "已恢复默认频道配置。";
}
async function savePolicy(channel: string) {
  const draft = policyDraft.value[channel] || emptyDraft();
  const policy: ChannelPolicy = {};
  for (const field of ["timeoutMs", "maxPages", "maxResults"] as const) {
    const raw = (draft[field] || "").trim();
    if (!raw) continue;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) { error.value = `频道 @${channel} 的抓取策略需为正整数。`; return; }
    policy[field] = parsed;
  }
  if (draft.fallback) policy.fallback = draft.fallback;
  const merged: Record<string, ChannelPolicy> = { ...(saved.value.policies ?? {}) };
  if (Object.keys(policy).length) merged[channel] = policy;
  else delete merged[channel];
  const channels = saved.value.channels === null ? null : [...saved.value.channels];
  if (await saveChannels(channels, merged)) message.value = `@${channel} 的抓取策略已保存，下一次本站搜索生效。`;
}
async function probe(channel: string, options = { keyword: keyword.value.trim(), limit: 10 }) {
  if (running.value || !channel || !options.keyword.trim()) return;
  const payload = { channel, keyword: options.keyword.trim(), limit: options.limit };
  running.value = channel;
  requests.value[channel] = payload;
  delete reports.value[channel];
  delete probeErrors.value[channel];
  probeController = new AbortController();
  try {
    const result = await $fetch<TgProbeResult>("/api/tg/probe", { method: "POST", body: payload, retry: 0, signal: probeController.signal });
    if (!disposed) {
      reports.value[channel] = result;
      // 检测成功后同步行内健康摘要，避免依赖整体刷新。
      channelHealth.value = {
        ...channelHealth.value,
        [channel]: {
          state: result.state === "available" ? "available" : result.state === "warning" ? "warning" : "error",
          elapsedMs: typeof result.elapsedMs === "number" ? result.elapsedMs : null,
          resultsCount: Array.isArray(result.results) ? result.results.length : null,
          message: String(result.message || ""),
          failureKind: String((result as unknown as { failureKind?: string }).failureKind || ""),
        },
      };
    }
  } catch (reason: any) {
    if (disposed) return;
    if ((reason?.statusCode || reason?.response?.status) === 401) emit("unauthorized");
    probeErrors.value[channel] = reason?.data?.statusMessage || reason?.message || "调试请求失败，请重试。";
  } finally { if (!disposed) running.value = ""; }
}
watch(() => props.focusChannel, () => { if (loaded.value) syncFocusedFunction(); });
onBeforeUnmount(() => { disposed = true; probeController?.abort(); });
onMounted(() => { void load(); void loadMonitorSummary(); void loadParserSettings(); });
/** ---- 批量导入 / 导出（GET /api/tg/export 与 POST /api/tg/import） ---- */
type TgExportData = { version: number; exportedAt: string; channels: string[] | null; defaultChannels: string[]; effectiveChannels: string[]; policies: Record<string, ChannelPolicy> };
const fileInput = ref<HTMLInputElement | null>(null);
const ioBusy = ref(false), ioAction = ref<"" | "export" | "file" | "paste">("");
const ioMessage = ref(""), ioError = ref("");
const showPasteImport = ref(false), pasteText = ref("");
function ioFail(reason: any, fallback: string): string {
  if ((reason?.statusCode || reason?.response?.status) === 401) emit("unauthorized");
  return reason?.data?.statusMessage || reason?.message || fallback;
}
function downloadJsonFile(data: TgExportData) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `tg-channels-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
async function exportChannels() {
  if (ioBusy.value) return;
  ioBusy.value = true; ioAction.value = "export"; ioMessage.value = ""; ioError.value = "";
  try {
    const response = await $fetch<{ code: number; data: TgExportData }>("/api/tg/export");
    const data = response?.data;
    if (!data || typeof data !== "object") throw new Error("导出响应格式异常。");
    downloadJsonFile(data);
    ioMessage.value = `已导出频道配置（${(data.channels ?? data.effectiveChannels ?? []).length} 个频道），文件已开始下载。`;
  } catch (reason: any) {
    ioError.value = ioFail(reason, "导出失败，请重试。");
  } finally { ioBusy.value = false; ioAction.value = ""; }
}
function parseImportText(text: string): { body: Record<string, unknown> } | { error: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { error: "导入内容不是有效的 JSON。" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "导入内容必须是 JSON 对象。" };
  const record = parsed as Record<string, unknown>;
  if (!("channels" in record) && !("policies" in record)) return { error: "导入内容需包含 channels 和/或 policies 字段。" };
  return { body: record };
}
async function importChannels(body: Record<string, unknown>, source: "file" | "paste") {
  if (ioBusy.value) return;
  ioBusy.value = true; ioAction.value = source; ioMessage.value = ""; ioError.value = "";
  try {
    await $fetch("/api/tg/import", { method: "POST", body });
    await load();
    ioMessage.value = "导入成功，服务端配置已更新并重新加载。";
  } catch (reason: any) {
    ioError.value = ioFail(reason, "导入失败：服务端拒绝了这份配置（400 表示格式非法），现有配置未被修改。");
  } finally { ioBusy.value = false; ioAction.value = ""; }
}
async function importFromText() {
  const text = pasteText.value.trim();
  if (!text || ioBusy.value) return;
  const parsed = parseImportText(text);
  if ("error" in parsed) { ioMessage.value = ""; ioError.value = parsed.error; return; }
  await importChannels(parsed.body, "paste");
}
async function onImportFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || ioBusy.value) return;
  try {
    const parsed = parseImportText(await file.text());
    if ("error" in parsed) { ioMessage.value = ""; ioError.value = `文件 ${file.name}：${parsed.error}`; return; }
    await importChannels(parsed.body, "file");
  } catch { ioError.value = "读取导入文件失败。"; }
}
function togglePasteImport() {
  showPasteImport.value = !showPasteImport.value;
  if (!showPasteImport.value) pasteText.value = "";
}
function closePasteImport() { showPasteImport.value = false; pasteText.value = ""; }
</script>
<style scoped>
.manager-body { padding: 24px; display: grid; gap: 20px; }
.tg-master { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 14px 16px; border: 1px solid #e2e8f0; border-radius: 12px; background: #f8fafc; flex-wrap: wrap; }
.tg-master-switch { display: flex; align-items: center; gap: 12px; cursor: pointer; }
.tg-master-switch .toggle { width: 44px; height: 24px; border-radius: 999px; border: 1px solid #cbd5e1; background: #e2e8f0; position: relative; cursor: pointer; flex: 0 0 44px; transition: background 0.15s ease; }
.tg-master-switch .toggle span { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: white; transition: left 0.15s ease; box-shadow: 0 1px 2px rgba(15, 23, 42, 0.2); }
.tg-master-switch .toggle.on { background: #2563eb; border-color: #2563eb; }
.tg-master-switch .toggle.on span { left: 22px; }
.tg-master-switch strong { font-size: 13px; display: block; }
.tg-master-switch small { color: #64748b; font-size: 11px; }
.tg-master-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.tg-add { display: grid; gap: 10px; }
.tg-add > div { display: flex; gap: 10px; }
input, select { border: 1px solid #cbd5e1; padding: 10px 12px; min-height: 44px; border-radius: 8px; min-width: 0; font: inherit; }
.tg-add input { flex: 1; }
.tg-list-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; color: #475569; font-size: 13px; }
.tg-list-toolbar label { display: flex; align-items: center; gap: 10px; }
.tg-list-toolbar input { width: 140px; }
.tg-list-toolbar label span { white-space: nowrap; }
.tg-rows { border: 1px solid #e2e8f0; border-radius: 12px; max-height: 520px; overflow-y: auto; }
.tg-item { display: grid; }
.tg-policy { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; padding: 0 16px 12px 16px; background: #f8fafc; }
.tg-policy label { display: grid; gap: 4px; font-size: 12px; color: #475569; }
.tg-policy input, .tg-policy select { border: 1px solid #cbd5e1; padding: 8px 10px; min-height: 38px; border-radius: 8px; min-width: 0; font: inherit; background: white; }
.tg-policy-actions { display: flex; align-items: center; gap: 10px; }
.tg-policy .field-hint { grid-column: 1 / -1; margin: 0; }
.tg-row { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; gap: 16px; border-bottom: 1px solid #f1f5f9; }
.tg-channel { min-width: 0; display: grid; gap: 6px; overflow-wrap: anywhere; }
.tg-channel-name { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tg-origin { display: inline-flex; align-items: center; border-radius: 4px; padding: 1px 6px; font-size: 10px; background: #f1f5f9; color: #64748b; }
.tg-origin.custom { background: #eff6ff; color: #1d4ed8; }
.tg-flag { display: inline-flex; align-items: center; border-radius: 999px; padding: 1px 8px; font-size: 11px; font-weight: 600; }
.tg-flag.warn { background: #fef3c7; color: #92400e; }
.tg-flag.off { background: #e2e8f0; color: #475569; }
.tg-item-off .tg-channel { opacity: 0.62; }
.tg-row-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; flex-shrink: 0; }
.tg-empty { padding: 24px; color: #64748b; font-size: 14px; line-height: 1.8; }
.tg-io { display: grid; gap: 10px; }
.tg-io-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
.tg-io-file { display: none; }
.tg-io-message { font-size: 13px; color: #166534; }
.tg-io-error { font-size: 13px; color: #b91c1c; overflow-wrap: anywhere; }
.tg-io-paste { display: grid; gap: 10px; padding: 14px; border: 1px solid #e2e8f0; border-radius: 12px; background: #f8fafc; }
.tg-io-paste textarea { min-height: 140px; border: 1px solid #cbd5e1; border-radius: 8px; padding: 10px 12px; font: 12px/1.6 ui-monospace, monospace; resize: vertical; min-width: 0; background: white; box-sizing: border-box; color: #334155; }
.tg-io-paste-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.tg-health { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; }
.tg-health .status-dot {
  width: 10px;
  height: 10px;
  box-shadow: 0 0 0 3px rgba(148, 163, 184, 0.16);
}
.tg-row-actions { gap: 8px; }
button:focus-visible, input:focus-visible, a:focus-visible { outline: 2px solid #2563eb; outline-offset: 3px; }
@media (max-width: 640px) { .manager-body { padding: 16px; } .tg-master { align-items: stretch; flex-direction: column; } .tg-row, .tg-list-toolbar { flex-direction: column; align-items: stretch; } .tg-row-actions { justify-content: flex-end; } .tg-manager-header { flex-wrap: wrap; gap: 12px; } }

/* Telegram manager refresh: clearer hierarchy, denser rows, and stronger scanability. */
.tg-manager {
  border-color: #dfe7f1 !important;
  border-radius: 18px !important;
  box-shadow: 0 18px 45px rgba(30, 64, 110, 0.06);
}
.tg-manager > .tg-manager-header {
  padding: 26px 30px 22px !important;
  background: linear-gradient(180deg, #ffffff 0%, #fbfdff 100%);
  border-bottom: 1px solid #edf1f6;
}
.tg-manager > .tg-manager-header h2 {
  font-size: 16px !important;
  letter-spacing: -0.2px;
}
.tg-manager > .tg-manager-header p { font-size: 12px !important; color: #7b8798 !important; margin-top: 6px !important; }
.tg-manager > .tg-manager-header > span { font-size: 11px !important; color: #8b98aa !important; }
.manager-body { padding: 24px 30px 30px !important; gap: 16px !important; }
.tg-master {
  padding: 16px 18px !important;
  border-color: #d7e5fb !important;
  border-radius: 14px !important;
  background: linear-gradient(135deg, #f4f8ff 0%, #f9fbff 100%) !important;
}
.tg-master-switch { gap: 14px !important; }
.tg-master-switch .toggle { width: 48px !important; height: 28px !important; flex-basis: 48px !important; background: #cbd5e1 !important; border-color: #cbd5e1 !important; }
.tg-master-switch .toggle span { top: 3px !important; left: 3px !important; width: 20px !important; height: 20px !important; }
.tg-master-switch .toggle.on { background: #2563eb !important; border-color: #2563eb !important; }
.tg-master-switch .toggle.on span { left: 25px !important; }
.tg-master-switch strong { font-size: 14px !important; color: #172033; }
.tg-master-switch small { display: block; margin-top: 3px; font-size: 12px !important; color: #66758a !important; }
.tg-master-actions { gap: 14px !important; }
.tg-master-actions .button { min-height: 40px; }
.tg-effective-hint { margin: 0 !important; font-size: 11px !important; color: #7f8da1 !important; }
.tg-stat-strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.tg-stat-card { min-height: 88px; padding: 14px 16px; border: 1px solid #e5ebf3; border-radius: 12px; background: #fff; }
.tg-stat-card span, .tg-stat-card small { display: block; color: #738198; font-size: 11px; }
.tg-stat-card strong { display: block; margin: 5px 0 1px; color: #1b2940; font-size: 25px; line-height: 1.1; letter-spacing: -0.5px; }
.tg-stat-card small { color: #a1acba; font-size: 10px; }
.tg-stat-card.is-green { background: #f3fcf8; border-color: #d5f1e4; }
.tg-stat-card.is-green strong { color: #0f9f6e; }
.tg-stat-card.is-amber { background: #fffbf3; border-color: #f4e5c3; }
.tg-stat-card.is-amber strong { color: #d08a16; }
.tg-stat-card.is-muted { background: #f8fafc; }
.tg-source-settings { margin: 2px 0 0 !important; border-top: 1px solid #e9eef5; padding-top: 2px; }
.tg-source-settings summary { padding: 12px 0 !important; color: #40516a !important; font-size: 12px !important; font-weight: 650; }
.tg-add { gap: 8px !important; padding: 16px 18px; border: 1px solid #e5ebf3; border-radius: 13px; background: #f8fafc; }
.tg-add label { color: #34445a; font-size: 13px; font-weight: 650; }
.tg-add > div { gap: 10px !important; }
.tg-add input { min-height: 42px; border-color: #d7e0eb; background: #fff; }
.tg-add .button { min-height: 42px; padding: 0 17px; }
.tg-list-toolbar { padding: 6px 0 13px !important; color: #34445a !important; }
.tg-list-title { display: flex; align-items: baseline; gap: 8px; }
.tg-list-title strong { font-size: 16px; letter-spacing: -0.2px; }
.tg-list-title span { color: #92a0b1; font-size: 11px; font-variant-numeric: tabular-nums; }
.tg-toolbar-right { display: flex; align-items: center; flex-wrap: wrap; gap: 9px !important; }
.tg-list-toolbar label { gap: 7px !important; color: #6b7890; font-size: 11px; font-weight: 600; }
.tg-list-toolbar input { height: 40px !important; border-color: #d7e0eb !important; border-radius: 9px !important; background: #fff; font-size: 12px !important; padding: 0 11px !important; }
.tg-list-toolbar label:not(.tg-search-field) input { width: 112px; }
.tg-search-field input { width: 150px !important; }
.tg-list-toolbar .button { min-height: 40px; border-radius: 9px; padding: 0 14px; }
.tg-list-toolbar .text-button { min-height: 40px; padding: 0 4px; }
.tg-rows { max-height: 600px !important; border-color: #dfe7f1 !important; border-radius: 14px !important; background: #fff; }
.tg-item { background: #fff; transition: background 160ms ease; }
.tg-item:hover { background: #f8fbff; }
.tg-row { min-height: 88px; padding: 14px 17px !important; gap: 20px !important; border-bottom-color: #edf1f6 !important; }
.tg-channel { gap: 7px !important; }
.tg-channel-name { gap: 8px !important; }
.tg-channel-name strong { color: #1b2940; font-size: 14px; letter-spacing: -0.1px; }
.tg-origin { padding: 3px 8px !important; border-radius: 999px !important; font-size: 10px !important; background: #f0f4f9 !important; color: #6d7c90 !important; }
.tg-origin.custom { background: #eaf2ff !important; color: #2563eb !important; }
.tg-flag { font-size: 10px !important; }
.tg-health { font-size: 12px !important; color: #64748b; }
.tg-health .status-dot { width: 8px !important; height: 8px !important; box-shadow: 0 0 0 3px rgba(148, 163, 184, .13); }
.tg-row-actions { gap: 8px !important; }
.tg-parser-inline { min-width: 196px !important; gap: 5px !important; font-size: 10px !important; }
.tg-parser-inline select { min-height: 40px; padding: 8px 10px !important; border-color: #cbd8e8 !important; border-radius: 9px !important; color: #334155; }
.tg-row-actions .button.small { min-height: 40px; border-radius: 9px; padding: 0 12px; font-size: 11px; }
.tg-row-actions .danger-button { border-color: #f0b4ae !important; color: #c24135 !important; background: #fffafa !important; }
.tg-row-actions .danger-button:hover:not(:disabled) { background: #fff1ef !important; }
.tg-empty { padding: 42px 24px !important; font-size: 13px !important; }
.tg-io { padding-top: 1px; }
.tg-io-actions { gap: 9px !important; }
.tg-io-actions .button { min-height: 40px; border-radius: 9px; }
.tg-io-message, .tg-io-error { font-size: 12px !important; }
@media (max-width: 1100px) {
  .tg-row { align-items: flex-start; flex-direction: column; gap: 12px !important; }
  .tg-row-actions { width: 100%; justify-content: flex-start; }
  .tg-parser-inline { min-width: 210px !important; }
}
@media (max-width: 760px) {
  .tg-manager > .tg-manager-header, .manager-body { padding-left: 18px !important; padding-right: 18px !important; }
  .tg-stat-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .tg-list-toolbar { align-items: stretch !important; }
  .tg-toolbar-right { align-items: stretch; }
  .tg-toolbar-right > * { flex: 1 1 180px; }
  .tg-search-field, .tg-list-toolbar label:not(.tg-search-field) { display: grid !important; align-items: center; }
  .tg-list-toolbar label input, .tg-search-field input { width: 100% !important; }
  .tg-add > div { flex-direction: column; }
}
</style>

<style scoped>
.tg-parser-inline { display: inline-grid; gap: 4px; min-width: 170px; color: #64748b; font-size: 11px; }
.tg-parser-inline select { width: 100%; padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 7px; background: #fff; font: inherit; }
</style>

<style scoped>
.tg-function-editor { display: grid; gap: 10px; padding: 12px 16px 16px; border-top: 1px solid #e4ebf4; background: #f8fbff; }
.tg-function-request { display: grid; grid-template-columns: auto auto minmax(0, 1fr) minmax(0, 1fr); align-items: center; gap: 8px 12px; color: #475569; font-size: 11px; }
.tg-function-request strong { color: #1e293b; font-size: 12px; }
.tg-function-request code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #64748b; }
.tg-transform-field { display: grid; gap: 6px; color: #475569; font-size: 12px; font-weight: 650; }
.tg-transform-field textarea { width: 100%; box-sizing: border-box; min-height: 160px; padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 8px; color: #dbeafe; background: #0f172a; font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; resize: vertical; }
.tg-transform-field textarea:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
.tg-function-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
@media (max-width: 760px) { .tg-function-request { grid-template-columns: 1fr; } .tg-function-request code { white-space: normal; overflow-wrap: anywhere; } .tg-function-actions { align-items: stretch; flex-direction: column; } }
.function-label-line { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.function-file-actions { display: inline-flex; gap: 8px; font-size: 11px; font-weight: 500; }
.transform-file { display: none; }
</style>
