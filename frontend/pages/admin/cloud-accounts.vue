<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { ArrowUpRight, Cloud, RefreshCw } from '@lucide/vue';
import { apiFetch, apiErrorMessage, setDocumentHead } from '../../src/appRuntime';
import { DELIVERY_PROVIDERS, providerForm, providerPayload, providerRecord, type ProviderForm, type ProviderKey, type ProviderPolicy } from '../../lib/linkPolicy';
import { accountStatus, accountCheckResult, authReason, loginRequest, rebindQuestion, scanInstructions, sessionActive, sessionExpired, safeQrImage, usableAccount, type AccountCheckFeedback, type CloudAccount, type LoginSession } from '../../lib/cloudAccounts';
import type { MonitorData } from '../../components/monitor/monitorView';
import { Button } from '../../components/admin/ui/button';
import { Textarea } from '../../components/admin/ui/textarea';
import AdminDialog from '../../components/admin/AdminDialog.vue';
import CloudProviderCard from '../../components/admin/CloudProviderCard.vue';
import CloudPolicyDialog from '../../components/admin/CloudPolicyDialog.vue';
import { useAdminConfirm } from '../../composables/admin/useAdminConfirm';
import { useAdminSession } from '../../composables/admin/useAdminSession';
const confirm = useAdminConfirm(), admin = useAdminSession();
const accounts = ref<CloudAccount[]>([]), policies = ref<Record<ProviderKey, ProviderPolicy>>(providerRecord(() => providerForm() as ProviderPolicy));
const loaded = ref(false), loading = ref(false), error = ref(''), notice = ref('');
const busy = ref<ProviderKey | null>(null), dialog = ref<CloudAccount | null>(null), session = ref<LoginSession | null>(null);
const checkFeedback = ref<Partial<Record<ProviderKey, AccountCheckFeedback>>>({});
const creating = ref(false), loginError = ref(''), intent = ref('connect'), importing = ref(false), credential = ref('');
const policyKey = ref<ProviderKey | null>(null), policyForm = ref<ProviderForm | null>(null), policyBusy = ref(false);
const monitor = ref<MonitorData | null>(null);
const configured = computed(() => Object.fromEntries(accounts.value.map(a => [a.provider, usableAccount(a)])) as Partial<Record<ProviderKey, boolean>>);
let alive = true, generation = 0, pollTimer: ReturnType<typeof setTimeout> | undefined, refreshTimer: ReturnType<typeof setInterval> | undefined;
let loadController: AbortController | undefined, pollController: AbortController | undefined, checkController: AbortController | undefined;
function account(key: ProviderKey) { return accounts.value.find(a => a.provider === key); }
function name(key: ProviderKey) { return DELIVERY_PROVIDERS.find(p => p.key === key)?.name || key; }
function date(value?: string) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '未记录'; }
const runtimeOnline = computed(() => monitor.value?.workers.links.state === 'online');
const connectedCount = computed(() => accounts.value.filter(usableAccount).length);
const runtimeLabel = computed(() => {
  const worker = monitor.value?.workers.links;
  if (!worker || worker.state === 'unknown' || worker.state === 'unavailable') return '服务状态未知';
  if (worker.state === 'offline') return '服务离线';
  return worker.enabled && worker.scheduleEnabled !== false ? '服务在线' : '清理已暂停';
});
async function refreshStatus() {
  try { monitor.value = (await apiFetch<{ data: MonitorData }>('/api/monitor', { silentError: true })).data; }
  catch { monitor.value = null; }
}
async function load(quiet = false) {
  if (admin.locked.value || (quiet && loading.value)) return;
  loadController?.abort(); const controller = new AbortController(); loadController = controller; loading.value = true;
  try {
    const list = await apiFetch<{ data: { items: CloudAccount[] } }>('/api/admin/cloud-accounts', { cache: 'no-store', silentError: true, signal: controller.signal });
    if (!alive || controller.signal.aborted) return;
    accounts.value = list.data.items; loaded.value = true; error.value = '';
  } catch (e) { if (alive && !controller.signal.aborted) { error.value = apiErrorMessage(e, '读取网盘账号失败'); return; } }
  finally { if (controller === loadController) loading.value = false; }
  try {
    const policy = await apiFetch<{ data: { items: ProviderPolicy[] } }>('/api/settings/cloud-providers', { cache: 'no-store', silentError: true, signal: controller.signal });
    if (!alive || controller.signal.aborted) return;
    const next = providerRecord(() => providerForm() as ProviderPolicy);
    for (const item of policy.data.items) next[item.provider] = item;
    policies.value = next;
  } catch (e) { if (alive && !controller.signal.aborted) notice.value = apiErrorMessage(e, '转存与检测配置读取失败。'); }
}
function openPolicy(key: ProviderKey) { policyForm.value = providerForm(policies.value[key]); policyKey.value = key; }
function closePolicy() { if (policyBusy.value) return; policyKey.value = null; policyForm.value = null; }
async function savePolicy(form: ProviderForm) {
  const key = policyKey.value; if (!key || policyBusy.value) return;
  policyBusy.value = true; notice.value = '';
  try {
    const result = await apiFetch<{ data: ProviderPolicy }>(`/api/settings/cloud-providers/${key}`, { method: 'PUT', body: providerPayload(form), silentError: true });
    if (!alive) return;
    policies.value = { ...policies.value, [key]: result.data };
    notice.value = `${name(key)}配置已保存。`;
    policyKey.value = null; policyForm.value = null;
  } catch (e) { if (alive) error.value = apiErrorMessage(e, '保存配置失败'); }
  finally { policyBusy.value = false; }
}
async function choose(a: CloudAccount, mode: 'qr' | 'import', replace = false) {
  if (busy.value || loading.value || !!error.value) return;
  const request = loginRequest(a, replace);
  if (request.rebind && !await confirm.confirm(rebindQuestion(replace))) return;
  delete checkFeedback.value[a.provider];
  intent.value = request.intent; dialog.value = a; session.value = null; loginError.value = ''; credential.value = ''; importing.value = mode === 'import';
  if (mode === 'qr') await start();
}
async function cancelRemote(a: CloudAccount, s: LoginSession) {
  try { await apiFetch(`/api/admin/cloud-accounts/${a.provider}/login-sessions/${s.id}`, { method: 'DELETE', silentError: true }); }
  catch { if (alive) notice.value = '取消未确认，二维码会自动过期。'; }
}
function close() {
  if (creating.value || busy.value) return;
  const a = dialog.value, s = session.value; generation++; clearTimeout(pollTimer); pollController?.abort(); dialog.value = null; session.value = null; credential.value = ''; loginError.value = '';
  if (a && s && sessionActive(s.status)) void cancelRemote(a, s);
}
async function start() {
  const a = dialog.value; if (!a || creating.value) return;
  if (session.value && sessionActive(session.value.status)) await cancelRemote(a, session.value);
  const current = ++generation; clearTimeout(pollTimer); pollController?.abort(); creating.value = true; session.value = null; loginError.value = '';
  try {
    const result = await apiFetch<{ data: LoginSession }>(`/api/admin/cloud-accounts/${a.provider}/login-sessions`, { method: 'POST', body: { intent: intent.value, expectedEpoch: a.bindingEpoch }, silentError: true });
    if (!alive || current !== generation) { void cancelRemote(a, result.data); return; } session.value = result.data; schedule(current);
  } catch (e) { if (alive && current === generation) loginError.value = apiErrorMessage(e, '创建扫码会话失败'); }
  finally { if (current === generation) creating.value = false; }
}
function schedule(current: number) {
  if (!session.value || !sessionActive(session.value.status)) return;
  pollTimer = setTimeout(() => void poll(current), Math.max(2, session.value.intervalSeconds || 3) * 1000);
}
async function poll(current: number) {
  const a = dialog.value, s = session.value; if (!a || !s || current !== generation || !alive) return;
  if (sessionExpired(s)) { session.value = { ...s, status: 'expired', qrImage: undefined }; return; }
  if (document.visibilityState === 'hidden') { schedule(current); return; }
  const controller = new AbortController(); pollController = controller;
  try {
    const result = await apiFetch<{ data: LoginSession }>(`/api/admin/cloud-accounts/${a.provider}/login-sessions/${s.id}`, { cache: 'no-store', silentError: true, signal: controller.signal });
    if (!alive || controller.signal.aborted || current !== generation) return; session.value = result.data; loginError.value = '';
    if (result.data.status === 'connected') { notice.value = `${name(a.provider)}已连接。`; await load(); } else schedule(current);
  } catch (e) { if (!controller.signal.aborted && alive && current === generation) { loginError.value = apiErrorMessage(e, '读取扫码状态失败，将重试'); schedule(current); } }
}
async function saveImport() {
  const a = dialog.value; if (!a || busy.value || !credential.value.trim()) return; busy.value = a.provider; loginError.value = '';
  try {
    const result = await apiFetch<{ data: { items: CloudAccount[] } }>(`/api/admin/cloud-accounts/${a.provider}/import`, { method: 'POST', body: { credential: credential.value.trim(), intent: intent.value, expectedEpoch: a.bindingEpoch }, silentError: true });
    if (!alive) return; accounts.value = result.data.items; credential.value = ''; dialog.value = null; notice.value = '凭证已验证并加密保存。'; error.value = '';
  } catch (e) { if (alive) loginError.value = apiErrorMessage(e, '验证或保存凭证失败'); } finally { busy.value = null; }
}
async function check(a: CloudAccount) {
  if (busy.value || loading.value || error.value || admin.locked.value) return;
  busy.value = a.provider; notice.value = '';
  checkFeedback.value[a.provider] = { state: 'checking', message: '正在验证账号和目录访问权限…' };
  const controller = new AbortController(); checkController = controller;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 60000);
  try {
    const result = await apiFetch<{ data: { items: CloudAccount[] } }>(`/api/admin/cloud-accounts/${a.provider}/check`, { method: 'POST', silentError: true, signal: controller.signal });
    if (!alive || admin.locked.value || controller.signal.aborted) return;
    accounts.value = result.data.items;
    checkFeedback.value[a.provider] = accountCheckResult(result.data.items.find(item => item.provider === a.provider));
  } catch (e) {
    clearTimeout(timeout);
    if (!alive || admin.locked.value) return;
    checkFeedback.value[a.provider] = { state: 'error', message: timedOut ? '验证超时，请刷新账号状态后重试' : apiErrorMessage(e, '账号验证失败，请重试') };
    if (!timedOut) {
      const refreshTimeout = setTimeout(() => controller.abort(), 10000);
      try {
        const latest = await apiFetch<{ data: { items: CloudAccount[] } }>('/api/admin/cloud-accounts', { cache: 'no-store', silentError: true, signal: controller.signal });
        if (alive && !admin.locked.value && !controller.signal.aborted) accounts.value = latest.data.items;
      } catch { /* Keep the verification error visible even if the status refresh fails. */ }
      finally { clearTimeout(refreshTimeout); }
    }
  } finally {
    clearTimeout(timeout);
    if (checkController === controller) { checkController = undefined; busy.value = null; }
  }
}
async function disconnect(a: CloudAccount) {
  if (busy.value || !await confirm.confirm('断开连接只删除系统保存的凭证，网盘文件与官方账号不受影响，相关转存与清理将停止。确认断开？')) return;
  delete checkFeedback.value[a.provider];
  busy.value = a.provider;
  try { const result = await apiFetch<{ data: { items: CloudAccount[] } }>(`/api/admin/cloud-accounts/${a.provider}/connection`, { method: 'DELETE', body: { expectedEpoch: a.bindingEpoch }, silentError: true }); if (alive) { accounts.value = result.data.items; notice.value = '已断开连接，网盘文件未删除。'; } }
  catch (e) { if (alive) error.value = apiErrorMessage(e, '断开失败，请刷新状态'); } finally { busy.value = null; }
}
watch(() => admin.locked.value, locked => { if (!locked) void load(); else { loadController?.abort(); pollController?.abort(); checkController?.abort(); checkFeedback.value = {}; clearTimeout(pollTimer); generation++; accounts.value = []; loaded.value = false; dialog.value = null; credential.value = ''; policyKey.value = null; policyForm.value = null; } });
onMounted(() => { setDocumentHead({ title: '网盘账号 - pansou' }); void load(); void refreshStatus(); refreshTimer = setInterval(() => { if (document.visibilityState === 'visible' && !dialog.value && !policyKey.value && !busy.value) { void load(true); void refreshStatus(); } }, 30000); });
onBeforeUnmount(() => { alive = false; generation++; loadController?.abort(); pollController?.abort(); checkController?.abort(); clearTimeout(pollTimer); clearInterval(refreshTimer); const a = dialog.value, s = session.value; if (a && s && sessionActive(s.status)) void cancelRemote(a, s); credential.value = ''; });
</script>
<template>
  <main class="cloud-accounts" :aria-busy="loading">
    <header class="account-heading"><div class="account-title"><h1><Cloud :size="22" aria-hidden="true" />网盘账号</h1><span v-if="loaded" class="account-count">{{ connectedCount }} / {{ DELIVERY_PROVIDERS.length }} 已连接</span></div><Button variant="outline" :disabled="loading || !!busy" @click="load(); refreshStatus()"><RefreshCw :size="16" aria-hidden="true" />{{ loading ? '读取中…' : '刷新' }}</Button></header>

    <aside class="runtime-strip" aria-live="polite">
      <div class="runtime-summary"><span class="runtime-status"><i :class="{ online: runtimeOnline }" aria-hidden="true"></i>{{ runtimeLabel }}</span><span v-if="monitor" class="runtime-counts">待关联 <b>{{ monitor.links.syncPending.toLocaleString() }}</b><span class="runtime-divider">/</span>待清理 <b>{{ monitor.links.queues.cleanup.queued }}</b></span></div>
      <div class="runtime-links"><RouterLink to="/admin/tasks">后台任务<ArrowUpRight :size="14" aria-hidden="true" /></RouterLink><RouterLink to="/admin/monitor">运行监控<ArrowUpRight :size="14" aria-hidden="true" /></RouterLink></div>
    </aside>

    <p v-if="error" role="alert" class="account-error">{{ error }}<Button variant="outline" :disabled="loading" @click="load()">重新加载</Button></p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="!loaded && loading" role="status">读取中…</p>
    <p v-else-if="!loaded" class="account-hint">配置读取失败，请刷新重试。</p>

    <section v-else class="account-grid" aria-label="五家网盘账号与转存配置">
      <CloudProviderCard
        v-for="p in DELIVERY_PROVIDERS"
        :key="p.key"
        :provider="p.key"
        :account="account(p.key)"
        :policy="policies[p.key]"
        :configured="configured[p.key] || false"
        :busy="busy === p.key"
        :feedback="checkFeedback[p.key]"
        :disabled="loading || !!busy || !!error"
        @configure="openPolicy(p.key)"
        @qr="account(p.key) && choose(account(p.key)!, 'qr')"
        @import="account(p.key) && choose(account(p.key)!, 'import')"
        @check="account(p.key) && check(account(p.key)!)"
        @replace="account(p.key) && choose(account(p.key)!, account(p.key)?.qrSupported ? 'qr' : 'import', true)"
        @disconnect="account(p.key) && disconnect(account(p.key)!)"
      />
    </section>

    <CloudPolicyDialog v-if="policyKey && policyForm" :provider="policyKey" :policy="policyForm" :configured="configured[policyKey] || false" :busy="policyBusy" @close="closePolicy" @save="savePolicy" />

    <AdminDialog v-if="dialog" :title="(importing ? '高级导入 · ' : '扫码连接 · ') + name(dialog.provider)" :description="intent === 'replace' ? (dialog.subjectId ? '将更换全站服务账号；旧产物归属不会转移。' : '原凭证未完成身份核实，本次登录的账号将接管该网盘槽位；旧凭证的转存产物不会转移。') : importing ? '仅导入对应网盘的官方登录凭证；服务端验证后加密保存。' : scanInstructions(dialog.provider)" :busy="creating || !!busy" @close="close">
      <div class="account-dialog"><p v-if="loginError" role="alert" class="account-error">{{ loginError }}</p>
        <form v-if="importing" @submit.prevent="saveImport"><label for="cloud-credential">{{ dialog.provider === 'baidu' || dialog.provider === 'quark' ? '网页登录 Cookie' : '登录凭证 JSON' }}</label><p id="credential-hint" class="account-hint">{{ dialog.provider === 'baidu' || dialog.provider === 'quark' ? '复制官方网页请求的完整 Cookie。百度需要 BDUSS/BDUSS_BFESS 和 BAIDUID。' : '可导入同一官方会话的 access_token、refresh_token 和设备字段；账号 ID 与阿里存储空间由服务端核实。迅雷还需要有效的 x-captcha-token。' }}不要把凭证发给别人，保存成功后输入框会清空。</p><Textarea id="cloud-credential" v-model="credential" rows="7" maxlength="32768" autocomplete="off" autocapitalize="off" :spellcheck="false" aria-describedby="credential-hint" :disabled="!!busy" /><Button type="submit" :disabled="!!busy || !credential.trim()">{{ busy ? '正在验证并保存…' : '验证并保存' }}</Button></form>
        <template v-else><p role="status">{{ creating ? '正在生成二维码…' : session ? accountStatus(session.status) : '二维码未生成' }}</p><img v-if="session?.qrImage && safeQrImage(session.qrImage) && sessionActive(session.status)" class="login-qr" :src="session.qrImage" :alt="name(dialog.provider) + '登录二维码'" width="256" height="256" /><p v-if="session?.expiresAt && sessionActive(session.status)" class="account-hint">二维码有效至 {{ date(session.expiresAt) }}。请在手机端确认登录。</p><p v-if="session?.errorCode" role="status" class="account-error">{{ authReason(session.errorCode) }}</p><Button v-if="!creating && (!session || !sessionActive(session.status)) && session?.status !== 'connected'" @click="start">重新生成二维码</Button><Button variant="outline" :disabled="creating" @click="close">{{ session?.status === 'connected' ? '完成' : '取消连接' }}</Button></template>
      </div>
    </AdminDialog>
  </main>
</template>
<style scoped>
@layer components {
.cloud-accounts{display:grid;gap:20px;font-size:14px;line-height:1.6;min-width:0;color:var(--foreground)}
.account-heading,.account-title{display:flex;align-items:center;flex-wrap:wrap;gap:12px}.account-heading{justify-content:space-between}.account-heading h1{display:flex;align-items:center;gap:10px;margin:0;font-size:22px;font-weight:600;letter-spacing:-.5px}.account-count{color:var(--muted-foreground);font-size:12px}
.account-grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr))}
.account-hint{color:var(--muted-foreground)}.account-error{color:var(--destructive);overflow-wrap:anywhere}
.runtime-strip{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border:1px solid var(--border);border-radius:8px;background:var(--card);font-size:12px}
.runtime-summary,.runtime-status,.runtime-counts,.runtime-links,.runtime-links a{display:flex;align-items:center;gap:8px}.runtime-summary{flex-wrap:wrap;gap:20px}.runtime-status{font-weight:500}.runtime-status i{width:6px;height:6px;border-radius:50%;background:var(--muted-foreground)}.runtime-status i.online{background:#16a34a}.runtime-counts{color:var(--muted-foreground)}.runtime-counts b{color:var(--foreground);font-weight:500;font-variant-numeric:tabular-nums}.runtime-divider{margin:0 4px;color:var(--border)}.runtime-links{gap:18px}.runtime-links a{color:var(--muted-foreground);text-decoration:none;min-height:24px;gap:4px}.runtime-links a:hover{color:var(--foreground)}
.account-dialog{padding:24px;display:grid;gap:16px}.account-dialog form{display:grid;gap:16px}.account-dialog p{margin:0}.login-qr{justify-self:center;background:white;border:12px solid white;border-radius:8px;max-width:100%;height:auto;box-sizing:content-box}
@media(max-width:600px){.account-heading h1{font-size:20px}.account-title{gap:8px}.account-grid{grid-template-columns:minmax(0,1fr)}.runtime-summary{gap:10px}.runtime-strip{gap:8px}.account-dialog{padding:16px}.login-qr{width:220px}}
}
</style>
