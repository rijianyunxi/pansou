<template>
  <div class="upstream-app admin-feature-app" :data-ready="ready ? 'true' : 'false'">
    <AdminAccessGate
      v-if="checking || locked"
      :checking="checking"
      :authenticated="authenticated"
      :error="authError"
      title="进入管理后台" />

    <template v-else>
      <aside class="console-sidebar">
        <NuxtLink to="/" class="console-brand">
          <span class="brand-symbol"><ConsoleIcon name="box" :size="22" /></span>PanHub
          <span class="brand-tag">CONSOLE</span>
        </NuxtLink>
        <nav aria-label="后台导航">
          <NuxtLink to="/admin/monitor" class="console-nav-link"><ConsoleIcon name="activity" />运行监控</NuxtLink>
          <NuxtLink to="/admin/sources" class="console-nav-link"><ConsoleIcon name="box" />来源管理</NuxtLink>
          <NuxtLink to="/admin/users" :class="['console-nav-link', { active: feature === 'users' }]"><ConsoleIcon name="user" />用户管理</NuxtLink>
          <NuxtLink to="/admin/logs" :class="['console-nav-link', { active: feature === 'logs' }]"><ConsoleIcon name="activity" />搜索日志</NuxtLink>
          <NuxtLink to="/admin/policies" :class="['console-nav-link', { active: feature === 'policies' }]"><ConsoleIcon name="sliders" />搜索策略</NuxtLink>
        </nav>
      </aside>

      <div class="console-body">
        <header class="console-topbar">
          <div class="breadcrumbs">
            <ConsoleIcon name="grid" :size="16" /><span>管理后台</span>
            <ConsoleIcon name="chevron" :size="13" /><strong>{{ title }}</strong>
          </div>
          <div class="topbar-right">
            <span class="local-chip"><span></span>ADMIN SESSION</span>
            <span class="topbar-divider"></span>
            <NuxtLink to="/" class="back-search"><ConsoleIcon name="external" :size="14" />返回搜索</NuxtLink>
            <button class="session-button" type="button" @click="lock">
              <span class="user-avatar">P</span><span>退出后台</span><ConsoleIcon name="logout" :size="15" />
            </button>
          </div>
        </header>

        <main class="console-main admin-feature-main">
          <section class="feature-content">
            <p v-if="notice" class="feature-notice" :class="{ error: noticeIsError }" role="status">{{ notice }}</p>

            <template v-if="feature === 'users'">
              <section class="query-panel" aria-label="用户查询与操作">
                <form class="query-toolbar" @submit.prevent="runQuery">
                  <label class="query-input">
                    <ConsoleIcon name="search" :size="16" />
                    <input v-model.trim="userQuery" type="search" placeholder="按用户名查询" />
                  </label>
                  <select v-model="userStatus" class="query-select" aria-label="用户状态">
                    <option value="">全部状态</option>
                    <option value="active">正常</option>
                    <option value="disabled">已禁用</option>
                  </select>
                  <div class="query-actions">
                    <button class="button primary" type="submit"><ConsoleIcon name="search" :size="14" />查询</button>
                    <button class="button secondary" type="button" @click="resetQuery">重置</button>
                    <button class="button secondary" type="button" :disabled="selectedCount === 0 || busy" @click="disableSelectedUsers">
                      <ConsoleIcon name="lock" :size="14" />批量禁用<span v-if="selectedCount" class="action-count">{{ selectedCount }}</span>
                    </button>
                    <button class="button primary" type="button" @click="openCreateUser"><ConsoleIcon name="plus" :size="14" />创建用户</button>
                  </div>
                </form>
                <div class="query-meta">已选 {{ selectedCount }} 项 · 共 {{ displayTotal }} 个用户</div>
              </section>

              <section class="sources-panel directory-panel table-panel" aria-label="用户列表">
                <div class="table-scroll">
                  <table class="source-table directory-table admin-data-table user-table">
                    <thead><tr>
                      <th class="checkbox-column"><input type="checkbox" :checked="allCurrentSelected" :indeterminate="someCurrentSelected" aria-label="选择当前页全部用户" @change="toggleAllCurrent" /></th>
                      <th class="serial-column">序号</th><th>ID</th><th>用户</th><th>权限</th><th>状态</th><th>频道</th><th>IP</th><th>注册时间</th><th>操作</th>
                    </tr></thead>
                    <tbody>
                      <tr v-for="(item, index) in users" :key="item.id" :class="{ 'selected-row': isSelected(item.id) }">
                        <td class="checkbox-column"><input type="checkbox" :checked="isSelected(item.id)" :aria-label="`选择用户 ${item.username}`" @change="toggleSelection(item.id)" /></td>
                        <td class="serial-column">{{ rowNumber(index) }}</td><td>{{ item.id }}</td>
                        <td class="source-summary-cell"><div class="source-text"><div class="source-name">{{ item.username }}</div><div class="source-description">{{ item.nickname || '未设置昵称' }}</div></div></td>
                        <td><span :class="['role-badge', item.role === 'admin' ? 'admin' : 'user']">{{ item.role === 'admin' ? '管理员' : '普通用户' }}</span></td>
                        <td><span :class="['status-badge', item.status]">{{ item.status === 'active' ? '正常' : '已禁用' }}</span></td>
                        <td><button class="channel-count-button" type="button" @click="openUserChannels(item)">{{ item.channelCount ?? item.channels?.length ?? 0 }}</button></td><td>{{ item.lastLoginIp || '—' }}</td><td>{{ formatTime(item.createdAt || item.created_at) }}</td>
                        <td class="action-column"><div class="row-actions"><button class="button secondary tiny" type="button" @click="toggleUser(item)">{{ item.status === 'active' ? '禁用' : '启用' }}</button><button class="button secondary tiny" type="button" @click="revokeUser(item)">退出会话</button><button class="button danger-button tiny" type="button" @click="deleteUser(item)">删除</button></div></td>
                      </tr>
                      <tr v-if="!users.length"><td colspan="10" class="empty-cell">暂无用户数据，或服务端用户管理接口尚未启用。</td></tr>
                    </tbody>
                  </table>
                </div>
                <AdminPagination :page="page" :total-pages="pageCount" :total="displayTotal" :page-size="pageSize" @change="goToPage" @update:page-size="changePageSize" />
              </section>

              <Teleport to="body">
                <div v-if="createUserOpen" class="admin-modal-backdrop" @click.self="closeCreateUser">
                  <section class="admin-modal" role="dialog" aria-modal="true" aria-labelledby="create-user-title">
                    <header class="admin-modal-header">
                      <div><p class="modal-eyebrow">NEW USER</p><h2 id="create-user-title">创建用户</h2><p>设置新账号的初始信息，用户首次登录后可按要求修改密码。</p></div>
                      <button class="modal-close" type="button" aria-label="关闭创建用户弹窗" @click="closeCreateUser"><ConsoleIcon name="close" :size="18" /></button>
                    </header>
                    <form class="create-user-modal-form" @submit.prevent="createUser">
                      <label class="modal-field">用户名<input ref="usernameInput" v-model.trim="newUser.username" required minlength="4" maxlength="32" autocomplete="username" placeholder="至少 4 位字符" /></label>
                      <label class="modal-field">初始密码<input v-model="newUser.password" required minlength="6" maxlength="128" type="password" autocomplete="new-password" placeholder="至少 6 位字符" /></label>
                      <label class="modal-field">昵称<span class="optional-label">可选</span><input v-model.trim="newUser.nickname" maxlength="32" autocomplete="nickname" placeholder="请输入昵称" /></label>
                      <p v-if="modalError" class="modal-error" role="alert"><ConsoleIcon name="info" :size="15" />{{ modalError }}</p>
                      <div class="admin-modal-actions"><button class="modal-button secondary" type="button" :disabled="busy" @click="closeCreateUser">取消</button><button class="modal-button primary" type="submit" :disabled="busy">{{ busy ? '创建中…' : '创建用户' }}</button></div>
                    </form>
                  </section>
                </div>
              </Teleport>

              <Teleport to="body">
                <div v-if="userChannelsOpen" class="admin-modal-backdrop" @click.self="closeUserChannels">
                  <section class="admin-modal channels-modal" role="dialog" aria-modal="true" aria-labelledby="user-channels-title">
                    <header class="admin-modal-header">
                      <div><p class="modal-eyebrow">USER CHANNELS</p><h2 id="user-channels-title">{{ selectedUserChannels?.username || '用户' }}的频道</h2><p>查看该账号已保存的自定义频道。</p></div>
                      <button class="modal-close" type="button" aria-label="关闭" @click="closeUserChannels">×</button>
                    </header>
                    <p v-if="userChannelsLoading" class="modal-loading">正在读取频道…</p>
                    <p v-else-if="userChannelsError" class="modal-error"><ConsoleIcon name="info" :size="14" />{{ userChannelsError }}</p>
                    <div v-else-if="selectedUserChannels?.channels.length" class="channel-chip-list">
                      <span v-for="channel in selectedUserChannels.channels" :key="channel" class="channel-chip">@{{ channel }}</span>
                    </div>
                    <p v-else class="modal-empty">该用户还没有添加自定义频道。</p>
                  </section>
                </div>
              </Teleport>
            </template>

            <template v-else-if="feature === 'logs'">
              <section class="query-panel" aria-label="搜索日志查询与操作">
                <form class="query-toolbar" @submit.prevent="runQuery">
                  <label class="query-input"><ConsoleIcon name="search" :size="16" /><input v-model.trim="logQuery" type="search" placeholder="关键词 / 用户 / IP" /></label>
                  <div class="query-actions"><button class="button primary" type="submit"><ConsoleIcon name="search" :size="14" />查询</button><button class="button secondary" type="button" @click="resetQuery">重置</button><button class="button danger-button" type="button" :disabled="selectedCount === 0 || busy" @click="deleteSelectedLogs"><ConsoleIcon name="trash" :size="14" />删除选中<span v-if="selectedCount" class="action-count">{{ selectedCount }}</span></button></div>
                </form>
                <div class="query-meta">已选 {{ selectedCount }} 项 · 共 {{ displayTotal }} 条日志</div>
              </section>
              <section class="sources-panel directory-panel table-panel" aria-label="搜索日志列表">
                <div class="table-scroll">
                  <table class="source-table directory-table admin-data-table log-table">
                    <thead><tr><th class="checkbox-column"><input type="checkbox" :checked="allCurrentSelected" :indeterminate="someCurrentSelected" aria-label="选择当前页全部日志" @change="toggleAllCurrent" /></th><th class="serial-column">序号</th><th>时间</th><th>关键词</th><th>用户</th><th>会话</th><th>IP</th><th>搜索范围</th><th>操作</th></tr></thead>
                    <tbody>
                      <tr v-for="(item, index) in logs" :key="item.id" :class="{ 'selected-row': isSelected(item.id) }"><td class="checkbox-column"><input type="checkbox" :checked="isSelected(item.id)" :aria-label="`选择日志 ${item.id}`" @change="toggleSelection(item.id)" /></td><td class="serial-column">{{ rowNumber(index) }}</td><td>{{ formatTime(item.createdAt || item.created_at) }}</td><td class="break-cell">{{ item.keyword || item.kw || '—' }}</td><td>{{ item.username || item.userId || '未登录' }}</td><td>{{ item.sessionId || '—' }}</td><td>{{ formatIp(item.ip) }}</td><td><button v-if="isCustomScope(item)" class="scope-link" type="button" @click="openLogChannels(item)">自定义频道</button><span v-else>{{ searchScopeLabel(item) }}</span></td><td class="action-column"><button class="icon-button danger-icon" type="button" aria-label="删除日志" title="删除日志" @click="deleteLog(item)"><ConsoleIcon name="trash" :size="16" /></button></td></tr>
                      <tr v-if="!logs.length"><td colspan="9" class="empty-cell">暂无日志数据，或服务端日志接口尚未启用。</td></tr>
                    </tbody>
                  </table>
                </div>
                <AdminPagination :page="page" :total-pages="pageCount" :total="displayTotal" :page-size="pageSize" @change="goToPage" @update:page-size="changePageSize" />
              </section>

              <Teleport to="body">
                <div v-if="logChannelsOpen" class="admin-modal-backdrop" @click.self="closeLogChannels">
                  <section class="admin-modal channels-modal" role="dialog" aria-modal="true" aria-labelledby="log-channels-title">
                    <header class="admin-modal-header">
                      <div><p class="modal-eyebrow">SEARCH CHANNELS</p><h2 id="log-channels-title">本次搜索的频道</h2><p v-if="selectedLogChannels?.keyword">关键词：{{ selectedLogChannels.keyword }}</p></div>
                      <button class="modal-close" type="button" aria-label="关闭" @click="closeLogChannels">×</button>
                    </header>
                    <div v-if="selectedLogChannels?.channels.length" class="channel-chip-list">
                      <span v-for="channel in selectedLogChannels.channels" :key="channel" class="channel-chip">@{{ channel }}</span>
                    </div>
                    <p v-else class="modal-empty">这条日志没有记录具体频道。</p>
                  </section>
                </div>
              </Teleport>
            </template>

            <template v-else>
              <section class="feature-card policy-card" aria-label="搜索策略 JSON 配置">
                <div class="policy-card-header">
                  <div class="policy-card-copy">
                    <h2>策略配置</h2>
                  </div>
                  <div class="policy-card-actions">
                    <span class="policy-count">10 个配置项</span>
                    <button class="refresh-button" type="button" :disabled="loading" @click="loadData">
                      <ConsoleIcon name="refresh" :size="14" />{{ loading ? '读取中…' : '刷新数据' }}
                    </button>
                    <button class="primary-button" type="button" :disabled="busy" @click="savePolicy"><ConsoleIcon name="check" :size="14" />{{ busy ? '保存中…' : '保存策略' }}</button>
                  </div>
                </div>
                <div class="policy-editor">
                  <div class="policy-editor-toolbar"><span>JSON 配置</span><span>仅支持 10 个字段</span></div>
                  <textarea v-model="policyText" spellcheck="false" wrap="off" aria-label="搜索策略 JSON 配置"></textarea>
                </div>
                <div class="policy-field-guide" aria-label="搜索策略字段说明">
                  <div class="policy-guide-heading"><span>字段说明</span><span>配置含义</span></div>
                  <div class="policy-guide-grid">
                    <div class="policy-guide-item">
                      <span class="policy-guide-icon">注</span>
                      <div><div class="policy-guide-title"><strong>是否允许新用户注册</strong><code>registrationEnabled</code></div><p>true 允许注册，false 关闭注册入口。</p></div>
                    </div>
                    <div class="policy-guide-item">
                      <span class="policy-guide-icon">频</span>
                      <div><div class="policy-guide-title"><strong>匿名用户是否可使用自定义频道</strong><code>anonymousCustomChannels</code></div><p>true 允许匿名搜索自定义频道，false 仅登录用户可用。</p></div>
                    </div>
                    <div class="policy-guide-item">
                      <span class="policy-guide-icon">显</span>
                      <div><div class="policy-guide-title"><strong>是否展示登录注册按钮</strong><code>showAuthButtons</code></div><p>true 展示首页登录 / 注册入口，false 隐藏未登录用户的入口。</p></div>
                    </div>
                    <div class="policy-guide-item">
                      <span class="policy-guide-icon">时</span>
                      <div><div class="policy-guide-title"><strong>统一会话有效天数</strong><code>sessionDays</code></div><p>匿名用户和注册用户共用，范围为 1–365 天。</p></div>
                    </div>
                    <div class="policy-guide-item">
                      <span class="policy-guide-icon">数</span>
                      <div><div class="policy-guide-title"><strong>统一自定义频道数量上限</strong><code>customChannelLimit</code></div><p>匿名用户和注册用户共用，范围为 0–100 个。</p></div>
                    </div>
                    <div class="policy-guide-item">
                      <span class="policy-guide-icon">并</span>
                      <div><div class="policy-guide-title"><strong>默认并发请求数</strong><code>defaultConcurrency</code></div><p>未单独指定时使用，范围为 1–16。</p></div>
                    </div>
                    <div class="policy-guide-item">
                      <span class="policy-guide-icon">时</span>
                      <div><div class="policy-guide-title"><strong>统一请求 / transform 超时（ms）</strong><code>requestTimeoutMs</code></div><p>统一控制请求和 transform 执行超时，范围为 1000–60000 毫秒。</p></div>
                    </div>
                    <div class="policy-guide-item">
                      <span class="policy-guide-icon">断</span>
                      <div><div class="policy-guide-title"><strong>来源失败多少次后熔断</strong><code>circuitBreakerMaxFailures</code></div><p>同一来源在 5 分钟失败达到此次数后暂时停止请求，范围为 1–20 次，默认 5 次；成功请求不会让突发失败绕过熔断。</p></div>
                    </div>
                    <div class="policy-guide-item">
                      <span class="policy-guide-icon">总</span>
                      <div><div class="policy-guide-title"><strong>整次搜索超时（ms）</strong><code>searchTimeoutMs</code></div><p>控制一轮搜索最多执行多久，范围为 1000–120000 毫秒；超时后返回已完成的资源源结果。</p></div>
                    </div>
                    <div class="policy-guide-item">
                      <span class="policy-guide-icon">缓</span>
                      <div><div class="policy-guide-title"><strong>搜索缓存时长（分钟）</strong><code>cacheTtlMinutes</code></div><p>相同关键词的完整搜索结果在服务端复用，范围为 1–10 分钟。</p></div>
                    </div>
                  </div>
                </div>
                <p class="field-help">字段说明放在编辑器外，JSON 内容保持合法且只包含以上 10 个字段。</p>
              </section>
            </template>
          </section>
        </main>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import AdminAccessGate from "./AdminAccessGate.vue";
import ConsoleIcon from "../upstreams/ConsoleIcon.vue";

import AdminPagination from "./AdminPagination.vue";
const auth = useAuth();
type Feature = "users" | "logs" | "policies";
type AdminUser = { id: number; username: string; nickname?: string | null; role?: "admin" | "user"; status: "active" | "disabled"; channels?: string[]; channelCount?: number; lastLoginIp?: string | null; createdAt?: number; created_at?: number };
type AdminLog = { id: number; keyword?: string; kw?: string; username?: string; userId?: number | null; sessionId?: number | string; ip?: string; scope?: string; searchScope?: string; channels?: string[]; createdAt?: number; created_at?: number };
type UserPolicy = {
  registrationEnabled: boolean;
  showAuthButtons: boolean;
  anonymousCustomChannels: boolean;
  sessionDays: number;
  customChannelLimit: number;
  defaultConcurrency: number;
  requestTimeoutMs: number;
  circuitBreakerMaxFailures: number;
  searchTimeoutMs: number;
  cacheTtlMinutes: number;
};

const DEFAULT_POLICY: UserPolicy = {
  registrationEnabled: true,
  showAuthButtons: true,
  anonymousCustomChannels: false,
  sessionDays: 30,
  customChannelLimit: 10,
  defaultConcurrency: 4,
  requestTimeoutMs: 5000,
  circuitBreakerMaxFailures: 5,
  searchTimeoutMs: 30000,
  cacheTtlMinutes: 10,
};

const props = defineProps<{ feature: Feature }>();
const feature = computed(() => props.feature);
const title = computed(() => ({ users: "用户管理", logs: "搜索日志", policies: "搜索策略" })[props.feature]);
const checking = ref(true); const ready = ref(false); const authenticated = ref(false); const locked = ref(true);
const loading = ref(false); const busy = ref(false); const authError = ref(""); const notice = ref(""); const noticeIsError = ref(false);
const users = ref<AdminUser[]>([]); const logs = ref<AdminLog[]>([]); const userQuery = ref(""); const userStatus = ref(""); const logQuery = ref("");
const policyText = ref(JSON.stringify(DEFAULT_POLICY, null, 2));
const newUser = ref({ username: "", password: "", nickname: "" }); const createUserOpen = ref(false); const modalError = ref(""); const usernameInput = ref<HTMLInputElement | null>(null);
const selectedKeys = ref<string[]>([]); const page = ref(1); const pageSize = ref(20); const total = ref(0);
const userChannelsOpen = ref(false); const userChannelsLoading = ref(false); const userChannelsError = ref(""); const selectedUserChannels = ref<{ username: string; channels: string[] } | null>(null);
const logChannelsOpen = ref(false); const selectedLogChannels = ref<{ keyword: string; channels: string[] } | null>(null);

function statusOf(error: any) { return error?.statusCode || error?.response?.status || error?.status; }
function apiError(error: any): string { const status = statusOf(error); if (status === 401) return "请先登录管理员账号。"; if (status === 403) return "当前账号没有管理员权限。"; if (status === 404) return "服务端接口尚未部署，当前页面先保留入口。"; return error?.data?.statusMessage || error?.message || "后台请求失败。"; }
function show(message: string, error = false) { notice.value = message; noticeIsError.value = error; }
function formatTime(value: unknown) { const n = Number(value); return Number.isFinite(n) && n > 0 ? new Date(n).toLocaleString() : "—"; }
function formatIp(value: unknown) { const ip = String(value || "").trim(); return ip && ip.toLowerCase() !== "unknown" ? ip : "未知"; }
function isCustomScope(item: AdminLog) { return (item.scope || item.searchScope) === "custom_channels"; }
function searchScopeLabel(item: AdminLog) { return isCustomScope(item) ? "自定义频道" : "本站来源"; }
function unwrap<T>(result: any, key: string): T { return result?.[key] ?? result?.data?.[key] ?? result?.data ?? result; }
const displayTotal = computed(() => total.value);
const pageCount = computed(() => Math.max(1, Math.ceil(displayTotal.value / pageSize.value)));
const currentRowKeys = computed(() => props.feature === "users" ? users.value.map((item) => String(item.id)) : props.feature === "logs" ? logs.value.map((item) => String(item.id)) : []);
const selectedCount = computed(() => selectedKeys.value.length);
const allCurrentSelected = computed(() => currentRowKeys.value.length > 0 && currentRowKeys.value.every((key) => selectedKeys.value.includes(key)));
const someCurrentSelected = computed(() => currentRowKeys.value.some((key) => selectedKeys.value.includes(key)) && !allCurrentSelected.value);

function rowNumber(index: number) { return (page.value - 1) * pageSize.value + index + 1; }
function isSelected(id: string | number) { return selectedKeys.value.includes(String(id)); }
function toggleSelection(id: string | number) { const key = String(id); selectedKeys.value = isSelected(key) ? selectedKeys.value.filter((item) => item !== key) : [...selectedKeys.value, key]; }
function toggleAllCurrent(event: Event) { const checked = (event.target as HTMLInputElement).checked; const current = currentRowKeys.value; selectedKeys.value = checked ? [...new Set([...selectedKeys.value, ...current])] : selectedKeys.value.filter((key) => !current.includes(key)); }
function clearSelection() { selectedKeys.value = []; }
async function checkStatus() {
  checking.value = true;
  authError.value = "";
  try {
    const status = await $fetch<{ authenticated: boolean; user: { role?: string } | null }>("/api/account/session", {
      credentials: "include",
      cache: "no-store",
      retry: 0,
    });
    authenticated.value = status.authenticated;
    locked.value = !(status.authenticated && status.user?.role === "admin");
    ready.value = true;
    if (!locked.value) await loadData();
  } catch (error: any) {
    authenticated.value = false;
    locked.value = true;
    authError.value = apiError(error);
    ready.value = true;
  } finally {
    checking.value = false;
  }
}
async function lock() {
  createUserOpen.value = false;
  try {
    await $fetch("/api/account/logout", { method: "POST", credentials: "include", retry: 0 });
  } finally {
    authenticated.value = false;
    locked.value = true;
    await navigateTo("/");
  }
}

async function loadData() {
  if (locked.value || loading.value) return;
  loading.value = true; show("");
  try {
    if (props.feature === "users") {
      const result = await $fetch<any>("/api/admin/users", { query: { q: userQuery.value || undefined, status: userStatus.value || undefined, page: page.value, pageSize: pageSize.value }, cache: "no-store" });
      const data = result?.data ?? result; users.value = (data.users || data.items || []).map((item: AdminUser) => ({ ...item, channelCount: item.channelCount ?? item.channels?.length })); total.value = Number(data.total || users.value.length); page.value = Number(data.page || page.value);
    } else if (props.feature === "logs") {
      const result = await $fetch<any>("/api/admin/search-logs", { query: { q: logQuery.value || undefined, page: page.value, pageSize: pageSize.value }, cache: "no-store" });
      const data = result?.data ?? result; logs.value = data.logs || data.items || []; total.value = Number(data.total || logs.value.length); page.value = Number(data.page || page.value);
    } else {
      const result = await $fetch<any>("/api/settings/user-policy", { cache: "no-store" });
      policyText.value = JSON.stringify(normalizePolicy(unwrap<Partial<UserPolicy>>(result, "policy")), null, 2);
    }
  } catch (error: any) { if ([401, 403].includes(statusOf(error))) { authenticated.value = false; locked.value = true; } show(apiError(error), true); }
  finally { loading.value = false; }
}
function runQuery() { page.value = 1; clearSelection(); void loadData(); }
function resetQuery() { userQuery.value = ""; userStatus.value = ""; logQuery.value = ""; runQuery(); }
function goToPage(nextPage: number) { if (nextPage < 1 || nextPage > pageCount.value || nextPage === page.value) return; page.value = nextPage; clearSelection(); void loadData(); }
function changePageSize(size: number) { pageSize.value = size; page.value = 1; clearSelection(); void loadData(); }

function openCreateUser() { if (busy.value) return; newUser.value = { username: "", password: "", nickname: "" }; modalError.value = ""; createUserOpen.value = true; }
function closeCreateUser() { if (!busy.value) createUserOpen.value = false; }
function handleModalKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  if (createUserOpen.value) closeCreateUser();
  else if (userChannelsOpen.value) closeUserChannels();
  else if (logChannelsOpen.value) closeLogChannels();
}
async function createUser() { if (busy.value) return; busy.value = true; try { await $fetch("/api/admin/users", { method: "POST", body: newUser.value }); newUser.value = { username: "", password: "", nickname: "" }; modalError.value = ""; createUserOpen.value = false; show("用户已创建。"); await loadData(); } catch (error: any) { modalError.value = apiError(error); if (statusOf(error) === 401) locked.value = true; } finally { busy.value = false; } }
async function openUserChannels(item: AdminUser) {
  userChannelsOpen.value = true;
  userChannelsLoading.value = true;
  userChannelsError.value = "";
  selectedUserChannels.value = { username: item.username, channels: [] };
  try {
    const result = await $fetch<any>(`/api/admin/users/${encodeURIComponent(String(item.id))}/channels`, { cache: "no-store" });
    const data = unwrap<{ username?: string; channels?: string[] }>(result, "data");
    selectedUserChannels.value = { username: data.username || item.username, channels: data.channels || [] };
  } catch (error: any) {
    userChannelsError.value = apiError(error);
  } finally {
    userChannelsLoading.value = false;
  }
}
function closeUserChannels() { if (!userChannelsLoading.value) userChannelsOpen.value = false; }
function openLogChannels(item: AdminLog) {
  selectedLogChannels.value = { keyword: item.keyword || item.kw || "—", channels: item.channels || [] };
  logChannelsOpen.value = true;
}
function closeLogChannels() { logChannelsOpen.value = false; }
async function userAction(item: AdminUser, action: string) { if (busy.value) return; busy.value = true; try { const id = encodeURIComponent(String(item.id)); const method = action === "delete" || action === "sessions" || action === "revoke-sessions" ? "DELETE" : "POST"; const path = action === "delete" ? `/api/admin/users/${id}` : `/api/admin/users/${id}/${action}`; await $fetch(path, { method }); show(action === "delete" ? "用户已移入回收状态。" : "操作已完成。"); await loadData(); } catch (error: any) { show(apiError(error), true); } finally { busy.value = false; } }
async function toggleUser(item: AdminUser) { await userAction(item, item.status === "active" ? "disable" : "enable"); }
async function revokeUser(item: AdminUser) { await userAction(item, "sessions"); }
async function deleteUser(item: AdminUser) {
  if (busy.value || !import.meta.client || !window.confirm(`确定将用户「${item.username}」移入回收状态吗？该用户会被禁用并注销会话。`)) return;
  await userAction(item, "delete");
}
async function disableSelectedUsers() { if (!selectedCount.value || !import.meta.client || !window.confirm(`确定禁用选中的 ${selectedCount.value} 个用户吗？`)) return; busy.value = true; try { await Promise.all(selectedKeys.value.map((id) => $fetch(`/api/admin/users/${encodeURIComponent(id)}/disable`, { method: "POST" }))); clearSelection(); show("选中用户已禁用。"); await loadData(); } catch (error: any) { show(apiError(error), true); } finally { busy.value = false; } }
async function deleteSelectedLogs() { if (!selectedCount.value || !import.meta.client || !window.confirm(`确定删除选中的 ${selectedCount.value} 条日志吗？删除后不可恢复。`)) return; busy.value = true; try { await $fetch("/api/admin/search-logs", { method: "DELETE", body: { ids: selectedKeys.value.map(Number) } }); clearSelection(); page.value = Math.min(page.value, Math.max(1, Math.ceil((total.value - selectedCount.value) / pageSize.value))); show("选中日志已删除。"); await loadData(); } catch (error: any) { show(apiError(error), true); } finally { busy.value = false; } }
async function deleteLog(item: AdminLog) { if (busy.value || !import.meta.client || !window.confirm("确定删除这条搜索日志吗？删除后不可恢复。")) return; busy.value = true; try { await $fetch("/api/admin/search-logs", { method: "DELETE", body: { ids: [item.id] } }); clearSelection(); page.value = Math.min(page.value, Math.max(1, Math.ceil((total.value - 1) / pageSize.value))); show("日志已删除。"); await loadData(); } catch (error: any) { show(apiError(error), true); } finally { busy.value = false; } }

function normalizePolicy(value: unknown): UserPolicy {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Partial<UserPolicy> : {};
  return {
    registrationEnabled: typeof input.registrationEnabled === "boolean" ? input.registrationEnabled : DEFAULT_POLICY.registrationEnabled,
    showAuthButtons: typeof input.showAuthButtons === "boolean" ? input.showAuthButtons : DEFAULT_POLICY.showAuthButtons,
    anonymousCustomChannels: typeof input.anonymousCustomChannels === "boolean" ? input.anonymousCustomChannels : DEFAULT_POLICY.anonymousCustomChannels,
    sessionDays: typeof input.sessionDays === "number" && Number.isInteger(input.sessionDays) ? input.sessionDays : DEFAULT_POLICY.sessionDays,
    customChannelLimit: typeof input.customChannelLimit === "number" && Number.isInteger(input.customChannelLimit) ? input.customChannelLimit : DEFAULT_POLICY.customChannelLimit,
    defaultConcurrency: typeof input.defaultConcurrency === "number" && Number.isInteger(input.defaultConcurrency) ? input.defaultConcurrency : DEFAULT_POLICY.defaultConcurrency,
    requestTimeoutMs: typeof input.requestTimeoutMs === "number" && Number.isInteger(input.requestTimeoutMs) ? input.requestTimeoutMs : DEFAULT_POLICY.requestTimeoutMs,
    circuitBreakerMaxFailures: typeof input.circuitBreakerMaxFailures === "number" && Number.isInteger(input.circuitBreakerMaxFailures) ? input.circuitBreakerMaxFailures : DEFAULT_POLICY.circuitBreakerMaxFailures,
    searchTimeoutMs: typeof input.searchTimeoutMs === "number" && Number.isInteger(input.searchTimeoutMs) ? input.searchTimeoutMs : DEFAULT_POLICY.searchTimeoutMs,
    cacheTtlMinutes: typeof input.cacheTtlMinutes === "number" && Number.isInteger(input.cacheTtlMinutes) ? input.cacheTtlMinutes : DEFAULT_POLICY.cacheTtlMinutes,
  };
}

function policyPayload(): UserPolicy {
  let parsed: unknown;
  try { parsed = JSON.parse(policyText.value); } catch { throw new Error("策略配置必须是合法 JSON。"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("策略配置必须是 JSON 对象。");
  const input = parsed as Record<string, unknown>;
  const allowed = Object.keys(DEFAULT_POLICY);
  const unknownKey = Object.keys(input).find((key) => !allowed.includes(key));
  if (unknownKey) throw new Error(`不支持的策略项: ${unknownKey}`);
  const missingKey = allowed.find((key) => !Object.prototype.hasOwnProperty.call(input, key));
  if (missingKey) throw new Error(`缺少策略项: ${missingKey}`);
  if (typeof input.registrationEnabled !== "boolean") throw new Error("registrationEnabled 必须是布尔值。");
  if (typeof input.showAuthButtons !== "boolean") throw new Error("showAuthButtons 必须是布尔值。");
  if (typeof input.anonymousCustomChannels !== "boolean") throw new Error("anonymousCustomChannels 必须是布尔值。");
  if (!Number.isInteger(input.sessionDays) || Number(input.sessionDays) < 1 || Number(input.sessionDays) > 365) throw new Error("sessionDays 必须是 1 到 365 之间的整数。");
  if (!Number.isInteger(input.customChannelLimit) || Number(input.customChannelLimit) < 0 || Number(input.customChannelLimit) > 100) throw new Error("customChannelLimit 必须是 0 到 100 之间的整数。");
  if (!Number.isInteger(input.defaultConcurrency) || Number(input.defaultConcurrency) < 1 || Number(input.defaultConcurrency) > 16) throw new Error("defaultConcurrency 必须是 1 到 16 之间的整数。");
  if (!Number.isInteger(input.requestTimeoutMs) || Number(input.requestTimeoutMs) < 1000 || Number(input.requestTimeoutMs) > 60000) throw new Error("requestTimeoutMs 必须是 1000 到 60000 之间的整数。");
  if (!Number.isInteger(input.circuitBreakerMaxFailures) || Number(input.circuitBreakerMaxFailures) < 1 || Number(input.circuitBreakerMaxFailures) > 20) throw new Error("circuitBreakerMaxFailures 必须是 1 到 20 之间的整数。");
  if (!Number.isInteger(input.searchTimeoutMs) || Number(input.searchTimeoutMs) < 1000 || Number(input.searchTimeoutMs) > 120000) throw new Error("searchTimeoutMs 必须是 1000 到 120000 之间的整数。");
  if (!Number.isInteger(input.cacheTtlMinutes) || Number(input.cacheTtlMinutes) < 1 || Number(input.cacheTtlMinutes) > 10) throw new Error("cacheTtlMinutes 必须是 1 到 10 之间的整数。");
  return input as UserPolicy;
}

async function savePolicy() {
  if (busy.value) return;
  let payload: UserPolicy;
  try { payload = policyPayload(); } catch (error: any) { show(error.message, true); return; }
  busy.value = true;
  try {
    const result = await $fetch<any>("/api/settings/user-policy", { method: "PUT", body: payload });
    const savedPolicy = normalizePolicy(unwrap<Partial<UserPolicy>>(result, "policy"));
    policyText.value = JSON.stringify(savedPolicy, null, 2);
    auth.showAuthButtons.value = savedPolicy.showAuthButtons;
    show("策略已保存。");
  } catch (error: any) { show(apiError(error), true); }
  finally { busy.value = false; }
}

watch(createUserOpen, (open) => { if (import.meta.client) document.body.style.overflow = open ? "hidden" : ""; if (open) void nextTick(() => usernameInput.value?.focus()); });
watch(pageCount, (count) => { if (page.value > count) page.value = count; });
onMounted(() => { checkStatus(); window.addEventListener("keydown", handleModalKeydown); });
onBeforeUnmount(() => { window.removeEventListener("keydown", handleModalKeydown); document.body.style.overflow = ""; });
</script>

<style src="../../assets/upstream-console.css"></style>

<style scoped>
.feature-content { width: 100%; margin: 0; padding: 0; }
.feature-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; margin-bottom: 22px; }
.feature-heading h1 { margin: 0 0 7px; font-size: 29px; }
.feature-heading p:not(.eyebrow) { margin: 0; color: #64748b; font-size: 13px; }
.refresh-button { display: inline-flex; align-items: center; gap: 7px; min-height: 38px; padding: 8px 14px; border: 1px solid #dbe1ea; border-radius: 8px; color: #475569; background: #fff; font: 600 12px inherit; cursor: pointer; }
.refresh-button:hover:not(:disabled) { border-color: #93c5fd; color: #2563eb; background: #eff6ff; }
.refresh-button:disabled { cursor: wait; opacity: .55; }
.feature-notice { margin: 0 0 14px; padding: 10px 13px; border: 1px solid #dbeafe; border-radius: 8px; color: #1d4ed8; background: #eff6ff; font-size: 12px; }
.feature-notice:empty { display: none; }
.feature-notice.error { border-color: #fecaca; color: #b91c1c; background: #fef2f2; }
.query-panel { position: sticky; top: calc(var(--console-topbar-height) + 10px); z-index: 12; margin-bottom: 16px; padding: 0; border: 1px solid #dfe7f1; border-radius: 14px; background: rgba(255,255,255,.98); box-shadow: 0 10px 30px rgba(40,62,92,.06); overflow: visible; backdrop-filter: blur(12px); }
.query-toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 14px 16px; border-bottom: 1px solid #edf1f6; background: #fbfcfe; }
.query-input { display: flex; align-items: center; gap: 8px; flex: 1 1 260px; min-width: 220px; height: 44px; padding: 0 13px; border: 1px solid #dce5f0; border-radius: 10px; color: #7b8794; background: #fff; }
.query-input:focus-within { border-color: #60a5fa; box-shadow: 0 0 0 3px rgba(37,99,235,.1); }
.query-input input { min-width: 0; flex: 1; border: 0; outline: 0; color: #111827; background: transparent; font: inherit; font-size: 12px; }
.query-select { width: 120px; flex: 0 0 120px; height: 44px; padding: 0 25px 0 12px; border: 1px solid #dce5f0; border-radius: 10px; color: #475569; background: #fff; font: inherit; font-size: 12px; }
.query-actions { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.query-actions .button { min-height: 44px; border-radius: 10px; }
.action-count { min-width: 17px; padding: 1px 5px; border-radius: 99px; color: currentColor; background: rgba(255,255,255,.35); font-size: 10px; text-align: center; }
.query-meta { display: flex; align-items: center; min-height: 39px; margin: 0; padding: 0 16px; border-bottom: 1px solid #edf1f6; background: #fbfcfe; color: #8591a2; font-size: 10px; }
.table-panel { overflow: hidden; border: 1px solid #dfe7f1; border-radius: 14px; background: #fff; box-shadow: 0 10px 30px rgba(40,62,92,.06); }
.table-scroll { max-height: min(680px, calc(100vh - 300px)); overflow: auto; }
.table-scroll table { width: 100%; min-width: 0; table-layout: fixed; }
.table-scroll thead th { position: sticky; top: 0; z-index: 3; }
.table-scroll th, .table-scroll td { vertical-align: middle; }
.table-scroll td { color: #334155; }
/* Keep feature tables on the exact visual baseline used by 来源管理. */
.admin-feature-app .table-panel .directory-table {
  min-width: 980px !important;
  width: 100% !important;
  table-layout: fixed;
}
.admin-feature-app .table-panel .directory-table thead {
  box-shadow: inset 0 1px #e3eaf2, inset 0 -1px #dfe7f0;
}
.admin-feature-app .table-panel .directory-table th {
  height: 42px;
  padding: 0 12px;
  background: #f3f6fa;
  color: #526176;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .18px;
}
.admin-feature-app .table-panel .directory-table td {
  height: 72px;
  padding: 12px;
  border-bottom-color: #e9eef4;
  background: #fff;
  color: #334155;
  font-size: 11px;
}
.admin-feature-app .table-panel .directory-table tbody tr {
  box-shadow: none;
  transition: background-color 140ms ease;
}
.admin-feature-app .table-panel .directory-table tbody tr:nth-child(even) td {
  background: #fcfdff;
}
.admin-feature-app .table-panel .directory-table tbody tr:hover,
.admin-feature-app .table-panel .directory-table tbody tr:hover td {
  background: #f5f8fc;
  box-shadow: none;
}
.admin-feature-app .table-panel .directory-table tbody tr.selected-row td {
  background: #eff6ff;
  box-shadow: none;
}
.admin-feature-app .table-panel .directory-table tbody tr.selected-row td:first-child {
  box-shadow: inset 3px 0 #2563eb;
}
.admin-data-table { white-space: normal; }
.admin-data-table tbody tr { cursor: default; }
.admin-data-table tbody tr:hover { background: #f7faff; box-shadow: inset 3px 0 #9dc2fa; }
.admin-data-table tbody tr.selected-row { background: #eff6ff; }
.table-scroll input[type="checkbox"] { width: 15px; height: 15px; accent-color: #2563eb; }
.checkbox-column { width: 42px; padding-right: 3px !important; padding-left: 16px !important; text-align: center !important; }
.serial-column { width: 58px; color: #94a3b8 !important; font-variant-numeric: tabular-nums; }
.status-badge { display: inline-flex; padding: 3px 7px; border-radius: 999px; font-size: 10px; }
.role-badge { display: inline-flex; padding: 3px 7px; border-radius: 999px; font-size: 10px; }
.role-badge.admin { color: #7c2d12; background: #ffedd5; }
.role-badge.user { color: #1d4ed8; background: #dbeafe; }
.status-badge.active { color: #166534; background: #dcfce7; }.status-badge.disabled { color: #64748b; background: #f1f5f9; }
.table-action { margin-right: 8px; padding: 0; border: 0; color: #2563eb; background: transparent; font: inherit; font-size: 11px; cursor: pointer; }.table-action:hover { color: #1d4ed8; }
.empty-cell { padding: 34px 8px !important; color: #94a3b8 !important; text-align: center !important; }
.break-cell { max-width: 280px; overflow-wrap: anywhere; }
.user-avatar-cell { color: #468bb7; background: #edf7fb; }
.user-avatar-cell svg { width: 18px; height: 18px; }
.channel-count-button, .scope-link { padding: 3px 7px; border: 0; border-radius: 6px; color: #2563eb; background: #eff6ff; font: inherit; font-size: 11px; font-weight: 700; cursor: pointer; }
.channel-count-button:hover, .scope-link:hover { color: #1d4ed8; background: #dbeafe; }
.channel-count-button:focus-visible, .scope-link:focus-visible { outline: 2px solid #60a5fa; outline-offset: 2px; }
.modal-loading, .modal-empty { margin: 0; padding: 26px 0 4px; color: #64748b; font-size: 12px; text-align: center; }
.channels-modal { width: min(560px, 100%); }
.channel-chip-list { display: flex; flex-wrap: wrap; gap: 9px; padding-top: 22px; }
.channel-chip { display: inline-flex; align-items: center; min-height: 30px; padding: 5px 10px; border: 1px solid #dbeafe; border-radius: 999px; color: #1d4ed8; background: #eff6ff; font-size: 12px; }
.admin-data-table { min-width: 0 !important; width: 100% !important; }
.admin-data-table th { height: 38px; padding-top: 1px; color: #7f8b9d; background: #f8fafc; font-size: 9px; font-weight: 700; letter-spacing: .45px; }
.admin-data-table td { height: 82px; padding-top: 12px; padding-bottom: 12px; }
.admin-data-table tbody tr { transition: background 140ms ease, box-shadow 140ms ease; }
.admin-data-table .source-name { color: #1f2937; font-size: 12px; font-weight: 700; line-height: 1.35; }
.admin-data-table .source-description { margin: 0; color: #64748b; font-size: 10px; line-height: 1.4; }
.admin-data-table .row-actions { gap: 7px; justify-content: flex-end; }
.admin-data-table .row-actions .button.tiny, .admin-data-table .icon-button { border-radius: 8px; }

.user-table th:nth-child(1), .user-table td:nth-child(1) { width: 42px; }
.user-table th:nth-child(2), .user-table td:nth-child(2) { width: 58px; }
.user-table th:nth-child(3), .user-table td:nth-child(3) { width: 9%; }
.user-table th:nth-child(4), .user-table td:nth-child(4) { width: 20%; }
.user-table th:nth-child(5), .user-table td:nth-child(5) { width: 10%; }
.user-table th:nth-child(6), .user-table td:nth-child(6) { width: 10%; }
.user-table th:nth-child(7), .user-table td:nth-child(7) { width: 9%; }
.user-table th:nth-child(8), .user-table td:nth-child(8) { width: 13%; }
.user-table th:nth-child(9), .user-table td:nth-child(9) { width: 17%; }
.user-table th:nth-child(10), .user-table td:nth-child(10) { width: 22%; }
.log-table th:nth-child(1), .log-table td:nth-child(1) { width: 42px; }
.log-table th:nth-child(2), .log-table td:nth-child(2) { width: 58px; }
.log-table th:nth-child(3), .log-table td:nth-child(3) { width: 16%; }
.log-table th:nth-child(4), .log-table td:nth-child(4) { width: 18%; }
.log-table th:nth-child(5), .log-table td:nth-child(5) { width: 13%; }
.log-table th:nth-child(6), .log-table td:nth-child(6) { width: 12%; }
.log-table th:nth-child(7), .log-table td:nth-child(7) { width: 12%; }
.log-table th:nth-child(8), .log-table td:nth-child(8) { width: 16%; }
.log-table th:nth-child(9), .log-table td:nth-child(9) { width: 13%; }
.policy-table th:nth-child(1), .policy-table td:nth-child(1) { width: 42px; }
.policy-table th:nth-child(2), .policy-table td:nth-child(2) { width: 58px; }
.policy-table th:nth-child(3), .policy-table td:nth-child(3) { width: 25%; }
.policy-table th:nth-child(4), .policy-table td:nth-child(4) { width: 16%; }
.policy-table th:nth-child(5), .policy-table td:nth-child(5) { width: 39%; }
.policy-table th:nth-child(6), .policy-table td:nth-child(6) { width: 20%; }
.table-panel :deep(.pagination) { min-height: 42px; padding: 0 20px; background: #fbfcfe; }
.user-list-actions { display: flex; align-items: center; gap: 9px; }
.admin-modal-backdrop { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; padding: 20px; background: rgba(15, 23, 42, .42); backdrop-filter: blur(3px); }
.admin-modal { width: min(460px, 100%); padding: 24px; border: 1px solid #e5e7eb; border-radius: 16px; background: #fff; box-shadow: 0 24px 70px rgba(15, 23, 42, .22); }
.admin-modal-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; padding-bottom: 20px; border-bottom: 1px solid #eef2f7; }.admin-modal-header h2 { margin: 0 0 6px; color: #111827; font-size: 20px; }.admin-modal-header p:not(.modal-eyebrow) { margin: 0; color: #64748b; font-size: 12px; line-height: 1.65; }
.modal-eyebrow { margin: 0 0 7px; color: #2563eb; font: 700 10px ui-monospace, SFMono-Regular, Consolas, monospace; letter-spacing: 1.6px; }.modal-close { display: grid; place-items: center; width: 32px; height: 32px; flex: 0 0 32px; padding: 0; border: 0; border-radius: 8px; color: #64748b; background: transparent; cursor: pointer; }.modal-close:hover { color: #111827; background: #f1f5f9; }
.create-user-modal-form { display: flex; flex-direction: column; gap: 15px; padding-top: 20px; }.modal-field { display: flex; flex-direction: column; gap: 7px; color: #374151; font-size: 12px; font-weight: 650; }.modal-field input { min-height: 42px; padding: 9px 11px; border: 1px solid #dbe1ea; border-radius: 8px; outline: none; color: #111827; background: #fff; font: inherit; font-size: 13px; font-weight: 400; }.optional-label { margin-left: 5px; color: #94a3b8; font-size: 11px; font-weight: 400; }.modal-error { display: flex; align-items: flex-start; gap: 7px; margin: 0; padding: 10px 11px; border: 1px solid #fecaca; border-radius: 8px; color: #b91c1c; background: #fef2f2; font-size: 11px; line-height: 1.5; }.admin-modal-actions { display: flex; justify-content: flex-end; gap: 9px; padding-top: 7px; }.modal-button { min-height: 40px; padding: 8px 15px; border: 1px solid transparent; border-radius: 8px; font: 600 12px inherit; cursor: pointer; }.modal-button.primary { border-color: #2563eb; color: #fff; background: #2563eb; }.modal-button.primary:hover:not(:disabled) { background: #1d4ed8; }.modal-button.secondary { border-color: #dbe1ea; color: #475569; background: #fff; }.modal-button.secondary:hover:not(:disabled) { background: #f8fafc; }.modal-button:disabled { cursor: wait; opacity: .55; }
@media (min-width: 821px) { .query-toolbar { flex-wrap: nowrap; }.query-actions { flex-wrap: nowrap; }.query-input { min-width: 180px; }.query-actions .button { flex: 0 0 auto; } }
@media (max-width: 820px) { .feature-heading { flex-direction: column; align-items: stretch; }.query-toolbar { align-items: stretch; }.query-input { min-width: 100%; }.query-select { width: 100%; flex: 1 1 100%; }.query-actions { width: 100%; }.query-actions .button { flex: 1 1 auto; } }
@media (max-width: 700px) { .admin-data-table { min-width: 820px !important; }.query-toolbar { padding: 12px 16px; }.table-scroll { max-height: min(58vh, 560px); }.query-panel { top: calc(var(--console-topbar-height) + 6px); padding: 0; }.query-actions .button { flex: 1 1 calc(50% - 7px); }.admin-modal { padding: 20px; } }
</style>
