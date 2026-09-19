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
            <section class="strategy-overview" aria-labelledby="strategy-overview-title">
              <div class="strategy-overview-header">
                <div><p class="eyebrow">ROUTING OVERVIEW</p><h2 id="strategy-overview-title">代理策略</h2><p>资源源绑定策略后，从策略里的节点按权重选择线路。</p></div>
                <div class="strategy-header-actions"><button class="button primary" type="button" @click="openRouteCreate"><ConsoleIcon name="plus" :size="15" />新增策略</button><button class="button secondary" type="button" @click="openCreate"><ConsoleIcon name="plus" :size="15" />新增代理节点</button></div>
              </div>
              <div class="strategy-cards">
                <article v-for="route in primaryRoutes" :key="route.id" class="strategy-card">
                  <div class="strategy-card-top"><div class="strategy-card-title"><span class="strategy-card-dot"></span><div><strong>{{ route.name }}</strong><small>{{ route.sourceIds.length ? `${route.sourceIds.length} 个资源源已绑定` : '尚未绑定资源源' }}</small></div></div><div class="strategy-card-actions"><button class="text-button" type="button" @click="editRoute(route)">编辑</button><button class="text-button danger-text-button" type="button" @click="removeRoute(route)">删除</button></div></div>
                  <div v-if="route.sourceIds.length" class="strategy-source-chips"><span v-for="sourceId in route.sourceIds" :key="sourceId" class="strategy-source-chip">{{ sourceName(sourceId) }}</span></div>
                  <div class="strategy-card-route"><span class="strategy-action-label">节点分配</span><strong>{{ route.action === 'direct' ? '直接连接目标站点' : `${routeGroup(route)?.nodes.length || 0} 个节点按权重分配` }}</strong></div>
                  <div v-if="route.action === 'group'" class="strategy-node-chips"><span v-for="member in routeGroup(route)?.nodes || []" :key="member.nodeId" class="strategy-node-chip"><span>{{ member.node?.name || member.nodeId }}</span><b>权重 {{ member.weight }}</b></span><span v-if="!routeGroup(route)?.nodes.length" class="strategy-empty-chip">尚未配置节点</span></div>
                </article>
                <article v-if="!primaryRoutes.length" class="strategy-empty"><ConsoleIcon name="sliders" :size="20" /><div><strong>还没有代理策略</strong><p>先新增一条策略，选择资源源和节点。</p></div><button class="button primary" type="button" @click="openRouteCreate">新增策略</button></article>
              </div>
            </section>
            <section class="sources-panel directory-panel table-panel node-library-panel">
              <div class="subsection-heading"><div><p class="eyebrow">NODE LIBRARY</p><h2>节点库</h2><p>节点只负责提供线路；打开策略即可决定哪些节点参与。</p></div><span class="subsection-count">{{ nodes.length }} 个节点</span></div>
              <div class="table-scroll">
                <table class="source-table directory-table admin-data-table proxy-table">
                  <thead><tr><th>节点</th><th>今日用量</th><th>状态</th><th>最近错误</th><th>操作</th></tr></thead>
                  <tbody>
                    <tr v-for="node in nodes" :key="node.id">
                      <td data-label="节点" class="proxy-node-cell"><strong class="proxy-node-name">{{ node.name }}</strong><div class="table-muted mono proxy-node-address" :class="{ 'direct-node-address': isDirectNode(node) }" :title="node.baseUrl || '直接连接目标站点'">{{ node.baseUrl || '直接连接目标站点' }}</div></td>
                      <td data-label="今日用量">{{ node.quotaUsed }}<span v-if="node.dailyLimit"> / {{ node.dailyLimit }}</span><span v-else class="table-muted"> / 不限</span></td>
                      <td data-label="状态"><span class="proxy-status" :class="node.circuitState">{{ statusLabel(node) }}</span></td>
                      <td data-label="最近错误" class="break-cell" :title="node.lastError || undefined"><span class="proxy-error">{{ node.lastError || '—' }}</span></td>
                      <td data-label="操作" class="action-column"><div v-if="!isDirectNode(node)" class="row-actions"><button class="icon-button" type="button" :aria-label="`编辑 ${node.name}`" title="编辑" @click="edit(node)"><ConsoleIcon name="edit" :size="15" /></button><button class="icon-button" type="button" :aria-label="`恢复 ${node.name} 状态`" title="恢复状态" @click="reset(node)"><ConsoleIcon name="refresh" :size="15" /></button><button class="icon-button danger-icon" type="button" :aria-label="`删除 ${node.name}`" title="删除" @click="remove(node)"><ConsoleIcon name="trash" :size="15" /></button></div><span v-else class="system-node-label">系统节点</span></td>
                    </tr>
                    <tr v-if="!nodes.length"><td colspan="5" class="empty-cell">暂无代理节点。</td></tr>
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
          <header class="admin-modal-header"><div><p class="modal-eyebrow">PROXY NODE</p><h2 id="proxy-editor-title">{{ editing ? '编辑代理节点' : '添加代理节点' }}</h2><p>节点 ID 将根据名称自动生成；节点地址用于提供线路，每日额度为 0 表示不限额。</p></div><button class="modal-close" type="button" @click="closeEditor">×</button></header>
          <form class="proxy-form" @submit.prevent="save">
            <label class="modal-field">名称<input v-model.trim="form.name" required maxlength="100" placeholder="Worker 节点 A" /></label>
            <label class="modal-field">节点地址<input v-model.trim="form.baseUrl" required type="url" placeholder="https://xxx.workers.dev" /></label>
            <label class="modal-field">每日额度<input v-model.number="form.dailyLimit" required type="number" min="0" max="10000000" /><small>0 表示不限额。</small></label>
            <label class="modal-field proxy-toggle"><input v-model="form.enabled" type="checkbox" /><span>启用节点</span></label>
            <p v-if="formError" class="modal-error">{{ formError }}</p>
            <div class="admin-modal-actions"><button class="modal-button secondary" type="button" :disabled="busy" @click="closeEditor">取消</button><button class="modal-button primary" type="submit" :disabled="busy">{{ busy ? '保存中…' : '保存节点' }}</button></div>
          </form>
        </section>
      </div>
      <div v-if="routeEditorOpen" class="admin-modal-backdrop" @click.self="closeRouteEditor"><section class="admin-modal proxy-modal" role="dialog" aria-modal="true"><header class="admin-modal-header"><div><p class="modal-eyebrow">PROXY POLICY</p><h2>{{ routeEditing ? '编辑代理策略' : '新增代理策略' }}</h2><p>先勾选资源源，再选择参与策略的节点和权重。</p></div><button class="modal-close" type="button" @click="closeRouteEditor">×</button></header><form class="proxy-form" @submit.prevent="saveRoute"><label class="modal-field">策略名称<input v-model.trim="routeForm.name" required placeholder="例如：Telegram 资源、国内资源" /></label><fieldset class="source-picker"><legend>绑定哪些资源源</legend><label v-for="source in sources" :key="source.id" class="source-picker-row"><input type="checkbox" :checked="routeSourceSelected(source.id)" :disabled="!!sourceBindingOwner(source.id)" @change="toggleRouteSource(source.id)" /><span class="source-picker-name"><strong>{{ source.name }}</strong><small>{{ sourceBindingOwner(source.id) ? `已绑定：${sourceBindingOwner(source.id)}` : (source.enabled ? (source.description || source.url) : '已停用 · ' + (source.description || source.url)) }}</small></span></label><small v-if="!sources.length" class="field-helper">暂无可绑定的资源源，请先到来源管理添加。</small><small v-else class="field-helper">一个资源源只能绑定一条代理策略。</small></fieldset><fieldset class="node-picker"><legend>使用哪些节点</legend><label v-for="node in proxyNodes" :key="node.id" class="node-picker-row"><input type="checkbox" :checked="routeNodeSelected(node.id)" :disabled="!node.enabled && !routeNodeSelected(node.id)" @change="toggleRouteNode(node.id)" /><span class="node-picker-name"><strong>{{ node.name }}</strong><small>{{ !node.enabled ? '已停用，当前不会参与请求' : (isDirectNode(node) ? '直接连接目标站点' : '节点') }}</small></span><input v-if="routeNodeSelected(node.id)" v-model.number="routeMemberWeights[node.id]" class="node-weight-input" type="number" min="1" max="100" aria-label="节点权重" /><span v-if="routeNodeSelected(node.id)" class="node-weight-label">权重</span></label><small class="field-helper">权重越高，被选中的机会越大；停用或不可用的节点会自动跳过。</small></fieldset><p v-if="routeError" class="modal-error">{{ routeError }}</p><div class="admin-modal-actions"><button class="modal-button secondary" type="button" @click="closeRouteEditor">取消</button><button class="modal-button primary" type="submit">保存策略</button></div></form></section></div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import ConsoleIcon from "../sources/ConsoleIcon.vue";

import { computed, onMounted, ref } from "vue";

interface ProxyNode {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  dailyLimit: number;
  quotaUsed: number;
  circuitState: "closed" | "open" | "half-open" | "quota_exhausted";
  lastError: string | null;
  openedUntil: number | null;
  available: boolean;
}
interface ProxyGroup { id: string; name: string; description: string; enabled: boolean; fallbackAction: "error" | "direct"; nodes: Array<{ nodeId: string; weight: number; node?: ProxyNode }> }
interface ProxySource { id: string; name: string; description: string; url: string; enabled: boolean }
interface ProxyRoute { id: string; name: string; enabled: boolean; sourceIds: string[]; action: "direct" | "group"; groupId: string | null }

const nodes = ref<ProxyNode[]>([]);
const proxyNodes = nodes;
const groups = ref<ProxyGroup[]>([]);
const routes = ref<ProxyRoute[]>([]);
const sources = ref<ProxySource[]>([]);
const primaryRoutes = computed(() => routes.value);
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
const editingId = ref<string | null>(null);
const formError = ref("");
const form = ref({ name: "", baseUrl: "", dailyLimit: 0, enabled: true });
const routeEditorOpen = ref(false); const routeEditing = ref(false); const routeError = ref("");
const routeForm = ref({ id: "", name: "", sourceIds: [] as string[], groupId: "" });
const routeFallbackAction = ref<"error" | "direct">("error");
const routeMemberWeights = ref<Record<string, number>>({});
const routeSelectedNodeIds = ref<string[]>([]);

function routeGroup(route: ProxyRoute): ProxyGroup | undefined { return route.groupId ? groups.value.find((group) => group.id === route.groupId) : undefined; }
function isDirectNode(node: ProxyNode): boolean { return node.id === "direct" || !node.baseUrl; }
function sourceName(sourceId: string): string { return sources.value.find((source) => source.id === sourceId)?.name || sourceId; }
function sourceBindingOwner(sourceId: string): string {
  return routes.value.find((route) => route.id !== routeForm.value.id && route.sourceIds.includes(sourceId))?.name || "";
}
function routeSourceSelected(sourceId: string): boolean { return routeForm.value.sourceIds.includes(sourceId); }
function toggleRouteSource(sourceId: string): void {
  const selected = new Set(routeForm.value.sourceIds);
  if (selected.has(sourceId)) selected.delete(sourceId); else selected.add(sourceId);
  routeForm.value.sourceIds = [...selected];
}
function routeNodeSelected(nodeId: string): boolean { return routeSelectedNodeIds.value.includes(nodeId); }
function toggleRouteNode(nodeId: string): void { const index = routeSelectedNodeIds.value.indexOf(nodeId); if (index >= 0) { routeSelectedNodeIds.value.splice(index, 1); delete routeMemberWeights.value[nodeId]; } else { routeSelectedNodeIds.value.push(nodeId); routeMemberWeights.value[nodeId] = 1; } }

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
    groups.value = response.data?.groups || [];
    routes.value = response.data?.routes || [];
    sources.value = response.data?.sources || [];
    authenticated.value = true;
    locked.value = false;
  } catch (error: any) {
    authError.value = apiError(error);
    locked.value = true;
  } finally {
    checking.value = false;
  }
}

function openRouteCreate() { routeEditing.value = false; routeError.value = ""; routeSelectedNodeIds.value = []; routeMemberWeights.value = {}; routeFallbackAction.value = "error"; routeForm.value = { id: `strategy-${Date.now()}`, name: "", sourceIds: [], groupId: "" }; routeEditorOpen.value = true; }
function editRoute(route: ProxyRoute) { routeEditing.value = true; routeError.value = ""; const group = routeGroup(route); routeSelectedNodeIds.value = (group?.nodes || []).map((item) => item.nodeId); routeMemberWeights.value = Object.fromEntries((group?.nodes || []).map((item) => [item.nodeId, item.weight])); routeFallbackAction.value = group?.fallbackAction || "error"; routeForm.value = { id: route.id, name: route.name, sourceIds: [...route.sourceIds], groupId: route.groupId || "" }; routeEditorOpen.value = true; }
function closeRouteEditor() { routeEditorOpen.value = false; }
async function saveRoute() { routeError.value = ""; try { const members = routeSelectedNodeIds.value.map((nodeId) => ({ nodeId, weight: Number(routeMemberWeights.value[nodeId] || 1) })); if (!routeForm.value.sourceIds.length) throw new Error("至少选择一个资源源"); if (!members.length) throw new Error("至少选择一个节点"); let groupId = routeForm.value.groupId; const groupBody = { id: groupId || `${routeForm.value.id}-nodes`, name: `${routeForm.value.name || "策略"} 节点`, description: "由策略自动维护", enabled: true, fallbackAction: routeFallbackAction.value, nodes: members }; if (groupId) await $fetch(`/api/admin/proxy-groups/${encodeURIComponent(groupId)}`, { method: "PUT", body: groupBody }); else { const groupResponse = await $fetch<any>("/api/admin/proxy-groups", { method: "POST", body: groupBody }); groupId = groupResponse.data?.group?.id || groupBody.id; } const body = { ...routeForm.value, action: "group", groupId, sourceIds: routeForm.value.sourceIds }; const endpoint = routeEditing.value ? `/api/admin/proxy-routes/${encodeURIComponent(routeForm.value.id)}` : "/api/admin/proxy-routes"; await $fetch(endpoint, { method: routeEditing.value ? "PUT" : "POST", body }); closeRouteEditor(); await load(); show(routeEditing.value ? "策略已更新" : "策略已添加"); } catch (error: any) { routeError.value = apiError(error); } }
async function removeRoute(route: ProxyRoute) { if (!window.confirm(`确定删除「${route.name}」吗？`)) return; try { await $fetch(`/api/admin/proxy-routes/${encodeURIComponent(route.id)}`, { method: "DELETE" }); await load(); show("代理策略已删除"); } catch (error: any) { show(apiError(error), true); } }
function openCreate() {
  editing.value = false;
  editingId.value = null;
  formError.value = "";
  form.value = { name: "", baseUrl: "", dailyLimit: 0, enabled: true };
  editorOpen.value = true;
}

function edit(node: ProxyNode) {
  editing.value = true;
  editingId.value = node.id;
  formError.value = "";
  form.value = { name: node.name, baseUrl: node.baseUrl, dailyLimit: node.dailyLimit, enabled: node.enabled };
  editorOpen.value = true;
}

function closeEditor() { if (!busy.value) editorOpen.value = false; }

async function save() {
  busy.value = true;
  formError.value = "";
  try {
    const endpoint = editing.value && editingId.value ? `/api/admin/proxies/${encodeURIComponent(editingId.value)}` : "/api/admin/proxies";
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
.strategy-overview { margin: 0 0 22px; padding: 24px; border: 1px solid #dbe6f2; border-radius: 16px; background: linear-gradient(145deg, #f8fbff 0%, #ffffff 62%); box-shadow: 0 10px 28px rgba(30, 64, 175, .06); }
.strategy-overview-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.strategy-header-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.strategy-overview-header h2 { margin: 4px 0 6px; color: #0f172a; font-size: 20px; letter-spacing: -.02em; }
.strategy-overview-header p:not(.eyebrow) { margin: 0; color: #64748b; font-size: 13px; line-height: 1.6; }
.strategy-cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.strategy-card { min-width: 0; padding: 16px; border: 1px solid #dfe7f1; border-radius: 13px; background: #fff; transition: border-color .2s ease, box-shadow .2s ease; }
.strategy-card:hover { border-color: #b9cbea; box-shadow: 0 8px 22px rgba(15, 23, 42, .06); }
.strategy-card-top { display: flex; justify-content: space-between; gap: 12px; }
.strategy-card-actions { display: flex; align-items: flex-start; gap: 2px; }
.strategy-card-title { display: flex; align-items: flex-start; gap: 9px; min-width: 0; }.strategy-card-title > div { min-width: 0; }.strategy-card-title strong, .strategy-card-title small { display: block; }.strategy-card-title strong { color: #172033; font-size: 14px; }.strategy-card-title small { margin-top: 4px; overflow: hidden; color: #64748b; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.strategy-card-dot { width: 8px; height: 8px; flex: 0 0 8px; margin-top: 5px; border-radius: 50%; background: #3b82f6; }
.text-button { min-height: 32px; padding: 5px 9px; border: 0; border-radius: 7px; color: #2563eb; background: transparent; font: 600 12px inherit; cursor: pointer; }.text-button:hover { background: #eff6ff; }.danger-text-button { color: #dc2626; }.danger-text-button:hover { background: #fef2f2; }
.strategy-card-route { display: flex; align-items: baseline; gap: 8px; margin: 16px 0 12px; }.strategy-action-label { color: #94a3b8; font-size: 11px; }.strategy-card-route strong { color: #334155; font-size: 13px; }
.strategy-source-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }.strategy-source-chip { max-width: 100%; padding: 4px 8px; overflow: hidden; border-radius: 7px; color: #315f9f; background: #eef5ff; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.strategy-node-chips { display: flex; flex-wrap: wrap; gap: 7px; }.strategy-node-chip, .strategy-empty-chip { display: inline-flex; align-items: center; gap: 7px; min-height: 28px; padding: 4px 8px; border-radius: 7px; background: #f5f8fc; color: #475569; font-size: 11px; }.strategy-node-chip b { color: #64748b; font-size: 10px; font-weight: 500; }.strategy-empty-chip { color: #b45309; background: #fff7ed; }
.strategy-empty { display: flex; align-items: center; gap: 12px; grid-column: 1 / -1; padding: 20px; border: 1px dashed #cbd5e1; border-radius: 12px; color: #64748b; }.strategy-empty strong { color: #334155; }.strategy-empty p { margin: 4px 0 0; font-size: 12px; }.strategy-empty .button { margin-left: auto; }
.node-library-panel { overflow: hidden; }.subsection-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 20px 24px 8px; }.subsection-heading h2 { margin: 3px 0 5px; color: #1e293b; font-size: 17px; }.subsection-heading p:not(.eyebrow) { margin: 0; color: #64748b; font-size: 12px; }.subsection-count { padding: 5px 9px; border-radius: 999px; color: #475569; background: #f1f5f9; font-size: 11px; white-space: nowrap; }
.source-picker { display: grid; gap: 8px; margin: 0; padding: 13px; border: 1px solid #e2e8f0; border-radius: 10px; background: #f8fafc; }.source-picker legend { padding: 0 5px; color: #334155; font-size: 12px; font-weight: 700; }.source-picker-row { display: flex; align-items: center; gap: 9px; min-height: 42px; padding: 5px 7px; border-radius: 7px; background: #fff; cursor: pointer; }.source-picker-row:hover { background: #eff6ff; }.source-picker-row:has(input:disabled) { cursor: not-allowed; opacity: .62; }.source-picker-row > input[type="checkbox"] { width: 17px; height: 17px; accent-color: #2563eb; }.source-picker-name { display: flex; flex: 1; flex-direction: column; min-width: 0; }.source-picker-name strong { overflow: hidden; color: #334155; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }.source-picker-name small { margin-top: 2px; overflow: hidden; color: #94a3b8; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.node-picker { display: grid; gap: 8px; margin: 0; padding: 13px; border: 1px solid #e2e8f0; border-radius: 10px; background: #f8fafc; }.node-picker legend { padding: 0 5px; color: #334155; font-size: 12px; font-weight: 700; }.node-picker-row { display: flex; align-items: center; gap: 9px; min-height: 42px; padding: 5px 7px; border-radius: 7px; background: #fff; cursor: pointer; }.node-picker-row:hover { background: #eff6ff; }.node-picker-row > input[type="checkbox"] { width: 17px; height: 17px; accent-color: #2563eb; }.node-picker-name { display: flex; flex: 1; flex-direction: column; min-width: 0; }.node-picker-name strong { overflow: hidden; color: #334155; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }.node-picker-name small { margin-top: 2px; color: #94a3b8; font-size: 10px; }.node-weight-input { width: 58px; min-height: 30px; padding: 4px 6px; border: 1px solid #dbe1ea; border-radius: 6px; text-align: center; font-size: 12px; }.node-weight-label { color: #64748b; font-size: 10px; }.field-helper { margin: 0; color: #94a3b8; font-size: 11px; line-height: 1.5; }
.proxy-intro { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.proxy-intro h2 { margin: 0 0 6px; color: var(--text-primary); font-size: 18px; }
.proxy-intro p { margin: 0; color: var(--text-secondary); font-size: 13px; line-height: 1.6; }
.proxy-status { display: inline-flex; padding: 4px 8px; border-radius: 999px; font-size: 12px; font-weight: 700; background: #e8f6ed; color: #16803c; }
.proxy-status.open { background: #fff1e8; color: #c2410c; }
.proxy-status.half-open { background: #fff8db; color: #9a6700; }
.proxy-status.quota_exhausted { background: #feecec; color: #c62828; }
.proxy-form { display: grid; gap: 13px; }
.proxy-form .proxy-toggle { display: flex; flex-direction: row; align-items: center; justify-content: flex-start; gap: 8px; }
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
.direct-node-address, .system-node-label { color: #64748b; font-style: normal; }
.system-node-label { font-size: 11px; }
.proxy-error { display: -webkit-box; max-width: 100%; overflow: hidden; color: #b45309; line-height: 1.45; overflow-wrap: anywhere; text-overflow: ellipsis; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.proxy-table { min-width: 1040px; table-layout: fixed; }
.proxy-table th:nth-child(1), .proxy-table td:nth-child(1) { width: 35%; }
.proxy-table th:nth-child(2), .proxy-table td:nth-child(2) { width: 16%; }
.proxy-table th:nth-child(3), .proxy-table td:nth-child(3) { width: 13%; }
.proxy-table th:nth-child(4), .proxy-table td:nth-child(4) { width: 21%; }
.proxy-table th:nth-child(5), .proxy-table td:nth-child(5) { width: 15%; min-width: 150px; }
.proxy-table .action-column { white-space: nowrap; }
@media (max-width: 760px) {
  .strategy-overview { padding: 18px; }.strategy-overview-header { flex-direction: column; }.strategy-cards { grid-template-columns: 1fr; }.strategy-empty { align-items: flex-start; flex-wrap: wrap; }.strategy-empty .button { width: 100%; margin-left: 0; }
  .proxy-intro { align-items: stretch; flex-direction: column; }
  .proxy-table { width: 100%; min-width: 0 !important; }
  .proxy-table .break-cell { white-space: normal; }
  .proxy-table .row-actions { flex-wrap: wrap; }
  .admin-modal-backdrop { padding: 14px; }
  .admin-modal-header { padding: 18px 18px 16px; }
  .proxy-form { padding: 18px; }
  .subsection-heading { align-items: flex-start; flex-direction: column; padding: 18px 18px 8px; }
}
</style>
