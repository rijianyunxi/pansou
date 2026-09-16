<template>
  <div class="admin-feature-shell">
    <AdminAccessGate v-if="checking || locked" :checking="checking" :configured="configured" :busy="unlocking" :ready="ready" :error="authError" title="进入管理后台" description="用户、日志和策略属于敏感信息。验证成功后将建立管理会话。" @submit="unlock" @clear-error="authError = ''" />
    <template v-else>
      <aside class="feature-sidebar">
        <NuxtLink to="/" class="feature-brand"><span>▣</span>PanHub <small>CONSOLE</small></NuxtLink>
        <nav aria-label="后台导航">
          <NuxtLink to="/admin/monitor">运行监控</NuxtLink>
          <NuxtLink to="/admin/sources">来源管理</NuxtLink>
          <NuxtLink to="/admin/users" :class="{ active: feature === 'users' }">用户管理</NuxtLink>
          <NuxtLink to="/admin/logs" :class="{ active: feature === 'logs' }">搜索日志</NuxtLink>
          <NuxtLink to="/admin/policies" :class="{ active: feature === 'policies' }">搜索策略</NuxtLink>
        </nav>
      </aside>
      <main class="feature-main">
        <header class="feature-topbar">
          <div><span>管理后台</span><strong> / {{ title }}</strong></div>
          <div class="feature-top-actions"><NuxtLink to="/">返回搜索</NuxtLink><button type="button" @click="lock">退出后台</button></div>
        </header>
        <section class="feature-content">
          <div class="feature-heading">
            <div><p class="eyebrow">ADMIN MODULE</p><h1>{{ title }}</h1><p>{{ description }}</p></div>
            <button class="refresh-button" type="button" :disabled="loading" @click="loadData">{{ loading ? '读取中…' : '刷新数据' }}</button>
          </div>
          <p v-if="notice" class="feature-notice" :class="{ error: noticeIsError }" role="status">{{ notice }}</p>

          <template v-if="feature === 'users'">
            <section class="feature-card">
              <div class="card-header"><div><h2>创建用户</h2><p>管理员创建的用户首次登录后可按要求修改密码。</p></div></div>
              <form class="create-user-form" @submit.prevent="createUser">
                <input v-model.trim="newUser.username" required minlength="4" maxlength="32" placeholder="用户名" />
                <input v-model="newUser.password" required minlength="15" maxlength="128" type="password" placeholder="初始密码（至少 15 位）" />
                <input v-model.trim="newUser.nickname" maxlength="32" placeholder="昵称（可选）" />
                <button class="primary-button" type="submit" :disabled="busy">创建用户</button>
              </form>
            </section>
            <section class="feature-card">
              <div class="card-header"><div><h2>用户列表</h2><p>禁用账号会保留历史日志，并使现有登录会话失效。</p></div><input v-model.trim="userQuery" class="filter-input" placeholder="按用户名筛选" @change="loadData" /></div>
              <div class="table-wrap">
                <table><thead><tr><th>ID</th><th>用户名</th><th>昵称</th><th>状态</th><th>频道</th><th>注册时间</th><th>操作</th></tr></thead>
                  <tbody><tr v-for="item in users" :key="item.id"><td>{{ item.id }}</td><td>{{ item.username }}</td><td>{{ item.nickname || '—' }}</td><td><span :class="['status-badge', item.status]">{{ item.status === 'active' ? '正常' : '已禁用' }}</span></td><td>{{ item.channelCount ?? item.channels?.length ?? 0 }}</td><td>{{ formatTime(item.createdAt || item.created_at) }}</td><td><button class="table-action" type="button" @click="toggleUser(item)">{{ item.status === 'active' ? '禁用' : '启用' }}</button><button class="table-action" type="button" @click="revokeUser(item)">退出会话</button></td></tr><tr v-if="!users.length"><td colspan="7" class="empty-cell">暂无用户数据，或服务端用户管理接口尚未启用。</td></tr></tbody>
                </table>
              </div>
            </section>
          </template>

          <template v-else-if="feature === 'logs'">
            <section class="feature-card">
              <div class="card-header"><div><h2>搜索日志</h2><p>关键词、会话、用户、范围和 IP 仅用于服务管理与安全审计。</p></div><input v-model.trim="logQuery" class="filter-input" placeholder="关键词 / 用户 / IP" @change="loadData" /></div>
              <div class="table-wrap"><table><thead><tr><th>时间</th><th>关键词</th><th>用户</th><th>会话</th><th>IP</th><th>搜索范围</th></tr></thead><tbody><tr v-for="item in logs" :key="item.id"><td>{{ formatTime(item.createdAt || item.created_at) }}</td><td class="break-cell">{{ item.keyword || item.kw || '—' }}</td><td>{{ item.username || item.userId || '未登录' }}</td><td>{{ item.sessionId || '—' }}</td><td>{{ item.ip || '未知' }}</td><td>{{ item.scope || item.searchScope || '全站来源' }}</td></tr><tr v-if="!logs.length"><td colspan="6" class="empty-cell">暂无日志数据，或服务端日志接口尚未启用。</td></tr></tbody></table></div>
            </section>
          </template>

          <template v-else>
            <section class="feature-card policy-card">
              <div class="card-header"><div><h2>用户与搜索策略</h2><p>保存后仅影响新请求；请保留 JSON 字段名与数值类型。</p></div><button class="primary-button" type="button" :disabled="busy" @click="savePolicy">保存策略</button></div>
              <textarea v-model="policyText" spellcheck="false" aria-label="策略 JSON"></textarea>
              <p class="field-help">可配置注册开关、匿名/登录频道上限、搜索频率、并发数和日志保留天数。服务端会再次校验范围。</p>
            </section>
          </template>
        </section>
      </main>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import AdminAccessGate from "./AdminAccessGate.vue";

type Feature = "users" | "logs" | "policies";
type AdminUser = { id: number; username: string; nickname?: string | null; status: "active" | "disabled"; channels?: string[]; channelCount?: number; createdAt?: number; created_at?: number };
type AdminLog = { id: number; keyword?: string; kw?: string; username?: string; userId?: number | null; sessionId?: number | string; ip?: string; scope?: string; searchScope?: string; createdAt?: number; created_at?: number };

const props = defineProps<{ feature: Feature }>();
const feature = computed(() => props.feature);
const title = computed(() => ({ users: "用户管理", logs: "搜索日志", policies: "搜索策略" })[props.feature]);
const description = computed(() => ({ users: "查看账号状态、频道数量并执行基础会话管理。", logs: "按时间倒序查看搜索治理日志。", policies: "查看并保存账号、频道和搜索限流策略。" })[props.feature]);
const checking = ref(true);
const ready = ref(false);
const configured = ref(true);
const locked = ref(true);
const unlocking = ref(false);
const authError = ref("");
const loading = ref(false);
const busy = ref(false);
const notice = ref("");
const noticeIsError = ref(false);
const users = ref<AdminUser[]>([]);
const logs = ref<AdminLog[]>([]);
const userQuery = ref("");
const logQuery = ref("");
const policyText = ref("{}");
const newUser = ref({ username: "", password: "", nickname: "" });

function statusOf(error: any) { return error?.statusCode || error?.response?.status || error?.status; }
function apiError(error: any): string {
  const status = statusOf(error);
  if (status === 401) return "管理员会话已过期，请重新验证。";
  if (status === 403) return "请求被安全策略拒绝，请从当前站点访问后台。";
  if (status === 404) return "服务端接口尚未部署，当前页面先保留入口。";
  return error?.data?.statusMessage || error?.message || "后台请求失败。";
}
function show(message: string, error = false) { notice.value = message; noticeIsError.value = error; }
function formatTime(value: unknown) { const n = Number(value); return Number.isFinite(n) && n > 0 ? new Date(n).toLocaleString() : "—"; }

async function checkStatus() {
  checking.value = true;
  try {
    const status = await $fetch<{ configured: boolean; locked: boolean }>("/api/auth/admin-status", { cache: "no-store" });
    configured.value = status.configured; locked.value = status.locked; ready.value = true;
    if (!status.locked) await loadData();
  } catch (error: any) { authError.value = apiError(error); ready.value = true; }
  finally { checking.value = false; }
}
async function unlock(password: string) {
  unlocking.value = true; authError.value = "";
  try { await $fetch("/api/auth/admin-unlock", { method: "POST", body: { password } }); locked.value = false; await loadData(); }
  catch (error: any) { authError.value = apiError(error); }
  finally { unlocking.value = false; }
}
async function lock() {
  try { await $fetch("/api/auth/admin-lock", { method: "POST" }); } finally { locked.value = true; }
}
function unwrap<T>(result: any, key: string): T { return result?.[key] ?? result?.data?.[key] ?? result?.data ?? result; }
async function loadData() {
  if (locked.value || loading.value) return;
  loading.value = true; show("");
  try {
    if (props.feature === "users") {
      const result = await $fetch<any>("/api/admin/users", { query: { q: userQuery.value || undefined, page: 1, pageSize: 50 }, cache: "no-store" });
      users.value = (unwrap<any[]>(result, "users") || []).map((item) => ({ ...item, channelCount: item.channelCount ?? item.channels?.length }));
    } else if (props.feature === "logs") {
      const result = await $fetch<any>("/api/admin/search-logs", { query: { q: logQuery.value || undefined, page: 1, pageSize: 50 }, cache: "no-store" });
      logs.value = unwrap<AdminLog[]>(result, "logs") || [];
    } else {
      const result = await $fetch<any>("/api/settings/user-policy", { cache: "no-store" });
      policyText.value = JSON.stringify(unwrap<Record<string, unknown>>(result, "policy") || result, null, 2);
    }
    show("数据已更新。", false);
  } catch (error: any) {
    if (statusOf(error) === 401) locked.value = true;
    show(apiError(error), true);
  } finally { loading.value = false; }
}
async function createUser() {
  if (busy.value) return;
  busy.value = true;
  try {
    await $fetch("/api/admin/users", { method: "POST", body: newUser.value });
    newUser.value = { username: "", password: "", nickname: "" }; show("用户已创建。"); await loadData();
  } catch (error: any) { show(apiError(error), true); }
  finally { busy.value = false; }
}
async function userAction(item: AdminUser, action: string) {
  if (busy.value) return;
  busy.value = true;
  try {
    const id = encodeURIComponent(item.id);
    if (action === "revoke-sessions") await $fetch(`/api/admin/users/${id}/sessions`, { method: "DELETE" });
    else await $fetch(`/api/admin/users/${id}/${action}`, { method: "POST" });
    show("操作已完成。"); await loadData();
  } catch (error: any) { show(apiError(error), true); }
  finally { busy.value = false; }
}
async function toggleUser(item: AdminUser) { await userAction(item, item.status === "active" ? "disable" : "enable"); }
async function revokeUser(item: AdminUser) { await userAction(item, "revoke-sessions"); }
async function savePolicy() {
  if (busy.value) return;
  let payload: unknown;
  try { payload = JSON.parse(policyText.value); } catch { show("策略必须是合法 JSON。", true); return; }
  busy.value = true;
  try { await $fetch("/api/settings/user-policy", { method: "PUT", body: payload as Record<string, unknown> }); show("策略已保存。"); }
  catch (error: any) { show(apiError(error), true); }
  finally { busy.value = false; }
}
onMounted(checkStatus);
</script>

<style scoped>
.admin-feature-shell { min-height: 100vh; display: flex; background: #f5f7fa; color: #111827; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif; }
.feature-sidebar { width: 218px; flex: 0 0 218px; padding: 24px 13px; background: #101827; color: #cbd5e1; }
.feature-brand { display: flex; align-items: center; gap: 9px; padding: 8px 12px 26px; color: #fff; text-decoration: none; font-size: 17px; font-weight: 750; }
.feature-brand span { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; background: #2563eb; font-size: 15px; }
.feature-brand small { margin-left: 2px; color: #94a3b8; font-size: 8px; letter-spacing: 1.4px; }
.feature-sidebar nav { display: flex; flex-direction: column; gap: 4px; }
.feature-sidebar nav a { padding: 11px 12px; border-radius: 8px; color: #94a3b8; font-size: 12px; text-decoration: none; }
.feature-sidebar nav a:hover, .feature-sidebar nav a.active { color: #fff; background: #1e293b; }
.feature-main { flex: 1; min-width: 0; }
.feature-topbar { min-height: 62px; box-sizing: border-box; display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 0 30px; border-bottom: 1px solid #e5e7eb; background: #fff; color: #64748b; font-size: 12px; }
.feature-topbar strong { color: #111827; }
.feature-top-actions { display: flex; align-items: center; gap: 14px; }
.feature-top-actions a, .feature-top-actions button { border: 0; background: transparent; color: #64748b; font: inherit; cursor: pointer; text-decoration: none; }
.feature-top-actions a:hover, .feature-top-actions button:hover { color: #2563eb; }
.feature-content { width: min(1180px, calc(100% - 48px)); margin: 0 auto; padding: 36px 0 64px; }
.feature-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; margin-bottom: 22px; }
.eyebrow { margin: 0 0 8px; color: #2563eb; font: 700 10px ui-monospace, SFMono-Regular, Consolas, monospace; letter-spacing: 1.8px; }
.feature-heading h1 { margin: 0 0 7px; font-size: 29px; }
.feature-heading p:not(.eyebrow) { margin: 0; color: #64748b; font-size: 13px; }
.refresh-button, .primary-button { min-height: 38px; padding: 8px 14px; border: 1px solid #2563eb; border-radius: 8px; background: #2563eb; color: #fff; font: 600 12px inherit; cursor: pointer; }
.refresh-button:disabled, .primary-button:disabled { opacity: .5; cursor: wait; }
.feature-notice { margin: 0 0 14px; padding: 10px 13px; border: 1px solid #dbeafe; border-radius: 8px; background: #eff6ff; color: #1d4ed8; font-size: 12px; }
.feature-notice:empty { display: none; }
.feature-notice.error { border-color: #fecaca; background: #fef2f2; color: #b91c1c; }
.feature-card { margin-top: 16px; padding: 20px; border: 1px solid #e5e7eb; border-radius: 12px; background: #fff; box-shadow: 0 4px 18px rgba(15, 23, 42, .04); }
.card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 16px; }
.card-header h2 { margin: 0 0 5px; font-size: 16px; }
.card-header p { margin: 0; color: #64748b; font-size: 12px; }
.create-user-form { display: grid; grid-template-columns: 1fr 1.3fr 1fr auto; gap: 9px; }
.create-user-form input, .filter-input { min-height: 38px; box-sizing: border-box; padding: 8px 10px; border: 1px solid #dbe1ea; border-radius: 8px; outline: none; font: inherit; font-size: 12px; }
.create-user-form input:focus, .filter-input:focus, .policy-card textarea:focus { border-color: #60a5fa; box-shadow: 0 0 0 3px rgba(37,99,235,.1); }
.filter-input { width: 220px; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th { color: #64748b; font-size: 11px; font-weight: 650; text-align: left; white-space: nowrap; }
th, td { padding: 11px 8px; border-bottom: 1px solid #eef2f7; vertical-align: middle; }
td { color: #334155; }
.status-badge { display: inline-flex; padding: 3px 7px; border-radius: 999px; font-size: 10px; }
.status-badge.active { background: #dcfce7; color: #166534; }.status-badge.disabled { background: #f1f5f9; color: #64748b; }
.table-action { margin-right: 8px; padding: 0; border: 0; background: transparent; color: #2563eb; font: inherit; font-size: 11px; cursor: pointer; }
.empty-cell { padding: 28px 8px; color: #94a3b8; text-align: center; }
.break-cell { max-width: 280px; overflow-wrap: anywhere; }
.policy-card textarea { width: 100%; min-height: 390px; box-sizing: border-box; padding: 13px; border: 1px solid #dbe1ea; border-radius: 8px; outline: none; resize: vertical; color: #0f172a; background: #f8fafc; font: 12px/1.65 ui-monospace, SFMono-Regular, Consolas, monospace; }
.field-help { margin: 10px 0 0; color: #64748b; font-size: 11px; }
@media (max-width: 820px) { .admin-feature-shell { display: block; }.feature-sidebar { width: auto; padding: 12px; }.feature-brand { padding: 5px 7px 12px; }.feature-sidebar nav { flex-direction: row; overflow-x: auto; }.feature-sidebar nav a { white-space: nowrap; }.feature-topbar { padding: 0 16px; }.feature-content { width: calc(100% - 28px); padding-top: 22px; }.create-user-form { grid-template-columns: 1fr; }.filter-input { width: 100%; }.card-header, .feature-heading { flex-direction: column; align-items: stretch; } }
</style>

