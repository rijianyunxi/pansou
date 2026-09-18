<template>
  <div class="source-app admin-feature-app proxy-page">
    <AdminAccessGate v-if="checking || locked" :checking="checking" :authenticated="authenticated" :error="authError"
      title="进入代理节点管理" @authenticated="load" />
    <template v-else>
      <aside class="console-sidebar">
        <NuxtLink to="/" class="console-brand"><span class="brand-symbol"><ConsoleIcon name="box" :size="22" /></span>PanHub <span class="brand-tag">CONSOLE</span></NuxtLink>
        <nav aria-label="后台导航">
          <NuxtLink to="/admin/monitor" class="console-nav-link"><ConsoleIcon name="activity" />运行监控</NuxtLink>
          <NuxtLink to="/admin/sources" class="console-nav-link"><ConsoleIcon name="box" />来源管理</NuxtLink>
          <NuxtLink to="/admin/proxies" class="console-nav-link active"><ConsoleIcon name="globe" />代理节点</NuxtLink>
          <NuxtLink to="/admin/resources" class="console-nav-link"><ConsoleIcon name="database" />网盘资源</NuxtLink>
          <NuxtLink to="/admin/hot-searches" class="console-nav-link"><ConsoleIcon name="search" />热门搜索</NuxtLink>
          <NuxtLink to="/admin/users" class="console-nav-link"><ConsoleIcon name="user" />用户管理</NuxtLink>
          <NuxtLink to="/admin/logs" class="console-nav-link"><ConsoleIcon name="activity" />搜索日志</NuxtLink>
          <NuxtLink to="/admin/policies" class="console-nav-link"><ConsoleIcon name="sliders" />系统设置</NuxtLink>
        </nav>
      </aside>
      <div class="console-body">
        <header class="console-topbar">
          <div class="breadcrumbs"><ConsoleIcon name="grid" :size="16" /><span>管理后台</span><ConsoleIcon name="chevron" :size="13" /><strong>代理节点</strong></div>
          <button class="session-button" type="button" @click="logout">退出后台 <ConsoleIcon name="logout" :size="15" /></button>
        </header>
        <main class="console-main admin-feature-main">
          <section class="feature-content">
            <p v-if="notice" class="feature-notice" :class="{ error: noticeError }" role="status">{{ notice }}</p>
            <div class="page-heading proxy-page-heading">
              <div>
                <p class="eyebrow">PROXY NODES</p>
                <h1>代理节点</h1>
                <p>管理 Telegram 的直连和 Worker 中转线路。</p>
              </div>
              <div class="heading-actions">
                <button class="button primary" type="button" @click="openCreate">
                  <ConsoleIcon name="plus" :size="15" />新增代理节点
                </button>
              </div>
            </div>
            <section class="sources-panel directory-panel table-panel">
              <div class="table-scroll">
                <table class="source-table directory-table admin-data-table proxy-table">
                  <thead><tr><th>节点</th><th>类型</th><th>权重</th><th>今日用量</th><th>状态</th><th>最近错误</th><th>操作</th></tr></thead>
                  <tbody>
                    <tr v-for="node in nodes" :key="node.id">
                      <td data-label="节点" class="proxy-node-cell"><strong class="proxy-node-name">{{ node.name }}</strong><div class="table-muted mono proxy-node-address" :title="node.kind === 'direct' ? '直连 Telegram' : node.baseUrl">{{ node.kind === 'direct' ? '直连 Telegram' : node.baseUrl }}</div></td>
                      <td data-label="类型"><span class="resource-chip">{{ node.kind === 'direct' ? '直连' : 'Worker' }}</span></td>
                      <td data-label="权重">{{ node.weight }}</td>
                      <td data-label="今日用量">{{ node.quotaUsed }}<span v-if="node.dailyLimit"> / {{ node.dailyLimit }}</span><span v-else class="table-muted"> / 不限</span></td>
                      <td data-label="状态"><span class="proxy-status" :class="node.circuitState">{{ statusLabel(node) }}</span></td>
                      <td data-label="最近错误" class="break-cell" :title="node.lastError || undefined"><span class="proxy-error">{{ node.lastError || '—' }}</span></td>
                      <td data-label="操作" class="action-column"><div class="row-actions"><button class="icon-button" type="button" :aria-label="`编辑 ${node.name}`" title="编辑" @click="edit(node)"><ConsoleIcon name="edit" :size="15" /></button><button class="icon-button" type="button" :aria-label="`恢复 ${node.name} 状态`" title="恢复状态" @click="reset(node)"><ConsoleIcon name="refresh" :size="15" /></button><button class="icon-button danger-icon" type="button" :aria-label="`删除 ${node.name}`" title="删除" @click="remove(node)"><ConsoleIcon name="trash" :size="15" /></button></div></td>
                    </tr>
                    <tr v-if="!nodes.length"><td colspan="7" class="empty-cell">暂无代理节点。</td></tr>
                  </tbody>
                </table>
              </div>
            </section>
          </section>
        </main>
      </div>
    </template>

    <Teleport to="body">
      <div v-if="editorOpen" class="admin-modal-backdrop" @click.self="closeEditor">
        <section class="admin-modal proxy-modal" role="dialog" aria-modal="true" aria-labelledby="proxy-editor-title">
          <header class="admin-modal-header"><div><p class="modal-eyebrow">PROXY NODE</p><h2 id="proxy-editor-title">{{ editing ? '编辑代理节点' : '添加代理节点' }}</h2><p>权重越高，被选中的概率越高；每日额度为 0 表示不限额。</p></div><button class="modal-close" type="button" @click="closeEditor">×</button></header>
          <form class="proxy-form" @submit.prevent="save">
            <label class="modal-field">节点 ID<input v-model.trim="form.id" :disabled="editing" required pattern="[a-z0-9][a-z0-9_-]{1,63}" placeholder="worker-a" /></label>
            <label class="modal-field">名称<input v-model.trim="form.name" required maxlength="100" placeholder="Worker 节点 A" /></label>
            <label class="modal-field">类型<select v-model="form.kind"><option value="proxy">Worker 代理</option><option value="direct">直连 Telegram</option></select></label>
            <label v-if="form.kind === 'proxy'" class="modal-field">Worker 地址<input v-model.trim="form.baseUrl" required type="url" placeholder="https://xxx.workers.dev" /></label>
            <label class="modal-field">调度权重<input v-model.number="form.weight" required type="number" min="1" max="100" /></label>
            <label class="modal-field">每日额度<input v-model.number="form.dailyLimit" required type="number" min="0" max="10000000" /><small>0 表示不限额。</small></label>
            <label class="modal-field proxy-toggle"><input v-model="form.enabled" type="checkbox" /><span>启用节点</span></label>
            <p v-if="formError" class="modal-error">{{ formError }}</p>
            <div class="admin-modal-actions"><button class="modal-button secondary" type="button" :disabled="busy" @click="closeEditor">取消</button><button class="modal-button primary" type="submit" :disabled="busy">{{ busy ? '保存中…' : '保存节点' }}</button></div>
          </form>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import ConsoleIcon from "../sources/ConsoleIcon.vue";

import { onMounted, ref } from "vue";

interface ProxyNode {
  id: string;
  name: string;
  kind: "direct" | "proxy";
  baseUrl: string;
  enabled: boolean;
  weight: number;
  dailyLimit: number;
  quotaUsed: number;
  circuitState: "closed" | "open" | "half-open" | "quota_exhausted";
  lastError: string | null;
  openedUntil: number | null;
}

const nodes = ref<ProxyNode[]>([]);
const checking = ref(true);
const locked = ref(true);
const authenticated = ref(false);
const authError = ref("");
const loading = ref(false);
const busy = ref(false);
const notice = ref("");
const noticeError = ref(false);
const editorOpen = ref(false);
const editing = ref(false);
const formError = ref("");
const form = ref({ id: "", name: "", kind: "proxy" as "proxy" | "direct", baseUrl: "", weight: 1, dailyLimit: 0, enabled: true });

function apiError(error: any): string {
  return error?.data?.statusMessage || error?.data?.message || error?.message || "请求失败";
}

function show(message: string, error = false) {
  notice.value = message;
  noticeError.value = error;
  window.setTimeout(() => { if (notice.value === message) notice.value = ""; }, 3500);
}

async function load() {
  checking.value = true;
  try {
    const response = await $fetch<any>("/api/admin/proxies", { credentials: "include", cache: "no-store" });
    nodes.value = response.data?.nodes || [];
    authenticated.value = true;
    locked.value = false;
  } catch (error: any) {
    authError.value = apiError(error);
    locked.value = true;
  } finally {
    checking.value = false;
  }
}

function openCreate() {
  editing.value = false;
  formError.value = "";
  form.value = { id: "", name: "", kind: "proxy", baseUrl: "", weight: 1, dailyLimit: 0, enabled: true };
  editorOpen.value = true;
}

function edit(node: ProxyNode) {
  editing.value = true;
  formError.value = "";
  form.value = { id: node.id, name: node.name, kind: node.kind, baseUrl: node.baseUrl, weight: node.weight, dailyLimit: node.dailyLimit, enabled: node.enabled };
  editorOpen.value = true;
}

function closeEditor() { if (!busy.value) editorOpen.value = false; }

async function save() {
  busy.value = true;
  formError.value = "";
  try {
    const endpoint = editing.value ? `/api/admin/proxies/${encodeURIComponent(form.value.id)}` : "/api/admin/proxies";
    await $fetch(endpoint, { method: editing.value ? "PUT" : "POST", body: form.value });
    editorOpen.value = false;
    await load();
    show(editing.value ? "代理节点已更新" : "代理节点已添加");
  } catch (error: any) {
    formError.value = apiError(error);
  } finally {
    busy.value = false;
  }
}

async function reset(node: ProxyNode) {
  try { await $fetch(`/api/admin/proxies/${encodeURIComponent(node.id)}/reset`, { method: "POST" }); await load(); show("节点状态已恢复"); }
  catch (error: any) { show(apiError(error), true); }
}

async function remove(node: ProxyNode) {
  if (!window.confirm(`确定删除「${node.name}」吗？`)) return;
  try { await $fetch(`/api/admin/proxies/${encodeURIComponent(node.id)}`, { method: "DELETE" }); await load(); show("代理节点已删除"); }
  catch (error: any) { show(apiError(error), true); }
}

function statusLabel(node: ProxyNode): string {
  if (!node.enabled) return "已停用";
  if (node.circuitState === "quota_exhausted") return "额度耗尽";
  if (node.circuitState === "open") return "熔断中";
  if (node.circuitState === "half-open") return "探测中";
  return "正常";
}

async function logout() {
  await $fetch("/api/account/logout", { method: "POST", credentials: "include" }).catch(() => undefined);
  await navigateTo("/");
}

onMounted(load);
</script>

<style src="../../assets/source-console.css"></style>
<style scoped>
.proxy-page { min-height: 100vh; }
.proxy-intro { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.proxy-intro h2 { margin: 0 0 6px; color: var(--text-primary); font-size: 18px; }
.proxy-intro p { margin: 0; color: var(--text-secondary); font-size: 13px; line-height: 1.6; }
.proxy-status { display: inline-flex; padding: 4px 8px; border-radius: 999px; font-size: 12px; font-weight: 700; background: #e8f6ed; color: #16803c; }
.proxy-status.open { background: #fff1e8; color: #c2410c; }
.proxy-status.half-open { background: #fff8db; color: #9a6700; }
.proxy-status.quota_exhausted { background: #feecec; color: #c62828; }
.proxy-form { display: grid; gap: 13px; }
.proxy-toggle { display: flex; align-items: center; gap: 8px; }
.proxy-toggle input { width: 17px; height: 17px; margin: 0; accent-color: #2563eb; }
.proxy-modal { width: min(560px, 100%); max-height: calc(100vh - 48px); overflow: auto; }
.admin-modal-backdrop { position: fixed; inset: 0; z-index: 200; display: grid; place-items: center; padding: 24px; background: rgba(15, 23, 42, .42); backdrop-filter: blur(3px); }
.admin-modal { box-sizing: border-box; border: 1px solid #dfe7f1; border-radius: 16px; background: #fff; box-shadow: 0 24px 70px rgba(15, 23, 42, .22); }
.admin-modal-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; padding: 22px 24px 20px; border-bottom: 1px solid #eef2f7; }
.admin-modal-header h2 { margin: 4px 0 6px; color: #111827; font-size: 20px; line-height: 1.35; }
.admin-modal-header p:not(.modal-eyebrow) { margin: 0; color: #64748b; font-size: 12px; line-height: 1.65; }
.modal-eyebrow { margin: 0 0 7px; color: #2563eb; font: 700 10px ui-monospace, SFMono-Regular, Consolas, monospace; letter-spacing: 1.6px; }
.modal-close { display: grid; place-items: center; width: 32px; height: 32px; flex: 0 0 32px; padding: 0; border: 0; border-radius: 8px; color: #64748b; background: transparent; font-size: 22px; line-height: 1; cursor: pointer; }
.modal-close:hover { color: #111827; background: #f1f5f9; }
.proxy-form { padding: 22px 24px 24px; }
.modal-field { display: flex; flex-direction: column; gap: 7px; color: #374151; font-size: 12px; font-weight: 650; }
.modal-field input:not([type="checkbox"]), .modal-field select { box-sizing: border-box; width: 100%; min-height: 42px; padding: 9px 11px; border: 1px solid #dbe1ea; border-radius: 8px; outline: none; color: #111827; background: #fff; font: inherit; font-size: 13px; font-weight: 400; }
.modal-field input:not([type="checkbox"]):focus, .modal-field select:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37, 99, 235, .12); }
.modal-field input:disabled { color: #64748b; background: #f8fafc; }
.modal-field small { color: #94a3b8; font-size: 11px; font-weight: 400; }
.modal-error { margin: 0; padding: 10px 11px; border: 1px solid #fecaca; border-radius: 8px; color: #b91c1c; background: #fef2f2; font-size: 11px; line-height: 1.5; }
.admin-modal-actions { display: flex; justify-content: flex-end; gap: 9px; padding-top: 7px; }
.modal-button { min-height: 40px; padding: 8px 15px; border: 1px solid transparent; border-radius: 8px; font: 600 12px inherit; cursor: pointer; }
.modal-button.primary { border-color: #2563eb; color: #fff; background: #2563eb; }
.modal-button.primary:hover:not(:disabled) { background: #1d4ed8; }
.modal-button.secondary { border-color: #dbe1ea; color: #475569; background: #fff; }
.modal-button.secondary:hover:not(:disabled) { background: #f8fafc; }
.modal-button:disabled { cursor: wait; opacity: .55; }
.break-cell { min-width: 0; max-width: none; overflow: hidden; white-space: normal; }
.proxy-node-cell { min-width: 0; white-space: normal; }
.proxy-node-name, .proxy-node-address { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.proxy-node-address { margin-top: 4px; }
.proxy-error { display: -webkit-box; max-width: 100%; overflow: hidden; color: #b45309; line-height: 1.45; overflow-wrap: anywhere; text-overflow: ellipsis; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.proxy-table { min-width: 1040px; table-layout: fixed; }
.proxy-table th:nth-child(1), .proxy-table td:nth-child(1) { width: 23%; }
.proxy-table th:nth-child(2), .proxy-table td:nth-child(2) { width: 11%; }
.proxy-table th:nth-child(3), .proxy-table td:nth-child(3) { width: 8%; }
.proxy-table th:nth-child(4), .proxy-table td:nth-child(4) { width: 14%; }
.proxy-table th:nth-child(5), .proxy-table td:nth-child(5) { width: 11%; }
.proxy-table th:nth-child(6), .proxy-table td:nth-child(6) { width: 18%; }
.proxy-table th:nth-child(7), .proxy-table td:nth-child(7) { width: 15%; min-width: 150px; }
.proxy-table .action-column { white-space: nowrap; }
@media (max-width: 760px) {
  .proxy-intro { align-items: stretch; flex-direction: column; }
  .proxy-table { width: 100%; min-width: 0 !important; }
  .proxy-table .break-cell { white-space: normal; }
  .proxy-table .row-actions { flex-wrap: wrap; }
  .admin-modal-backdrop { padding: 14px; }
  .admin-modal-header { padding: 18px 18px 16px; }
  .proxy-form { padding: 18px; }
}
</style>
