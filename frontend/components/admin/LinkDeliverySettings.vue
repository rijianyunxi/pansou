<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { apiErrorMessage, apiFetch } from '../../src/appRuntime';
import { providerForm, providerPayload, providerError, type ProviderKey, type DeliveryPolicy, type CheckPolicy } from '../../lib/linkPolicy';
import type { MonitorData } from '../monitor/monitorView';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Switch } from './ui/switch';
import AdminSelect from './AdminSelect.vue';
import CloudDirectoryPicker from './CloudDirectoryPicker.vue';
const props = defineProps<{ quarkConfigured: boolean; baiduConfigured: boolean }>();
const providers = [{ key: 'quark' as const, name: '夸克网盘' }, { key: 'baidu' as const, name: '百度网盘' }];
const policy = reactive({ revision: 1, quark: providerForm(), baidu: providerForm() });
const check = reactive<CheckPolicy>({ enabled: false, validSeconds: 86400, invalidSeconds: 604800, intervalSeconds: 2, dailyBudget: 1000 });
const busy = ref(false), loading = ref(true), loaded = ref(false), message = ref(''), error = ref(false);
const fieldErrors = reactive({ quark: '', baidu: '' });
const directoryNames = reactive({ quark: '', baidu: '' });
const picker = ref<ProviderKey | null>(null);
const monitor = ref<MonitorData | null>(null);
const saved = ref('');
function payload() { return { revision: policy.revision, quark: providerPayload(policy.quark), baidu: providerPayload(policy.baidu) }; }
function snapshot() { return JSON.stringify({ delivery: payload(), check: { ...check } }); }
const dirty = computed(() => loaded.value && snapshot() !== saved.value);
function configured(key: ProviderKey) { return key === 'quark' ? props.quarkConfigured : props.baiduConfigured; }
function enable(key: ProviderKey, value: boolean) {
  policy[key].enabled = value;
  if (value && policy[key].hours === '') policy[key].hours = 24;
  fieldErrors[key] = '';
}
function selectDirectory(dir: string, name: string) {
  if (picker.value) { policy[picker.value].targetDir = dir; directoryNames[picker.value] = name; fieldErrors[picker.value] = ''; }
  picker.value = null;
}
async function refreshStatus() {
  try { monitor.value = (await apiFetch<{ data: MonitorData }>('/api/monitor', { silentError: true })).data; }
  catch { monitor.value = null; }
}
const runtimeLabel = computed(() => {
  const worker = monitor.value?.workers.links;
  if (!worker || worker.state === 'unknown' || worker.state === 'unavailable') return '后台状态暂不可用';
  if (worker.state === 'offline') return '链接服务未启动';
  return worker.enabled ? '链接服务在线 · 到期清理已启用' : '链接服务在线 · 到期清理已暂停';
});
let timer: ReturnType<typeof setInterval> | undefined;
async function load() {
  loading.value = true; message.value = ''; error.value = false;
  try {
    const [result, checks] = await Promise.all([apiFetch<{ data: DeliveryPolicy }>('/api/settings/link-delivery'), apiFetch<{ data: CheckPolicy }>('/api/settings/link-check')]);
    policy.revision = result.data.revision;
    for (const { key } of providers) Object.assign(policy[key], providerForm(result.data[key]));
    Object.assign(check, checks.data);
    loaded.value = true; saved.value = snapshot();
  } catch (e) { message.value = apiErrorMessage(e, '读取链接策略失败，请重试。'); error.value = true; }
  finally { loading.value = false; }
}
onMounted(() => { void load(); void refreshStatus(); timer = setInterval(() => void refreshStatus(), 15000); });
onBeforeUnmount(() => clearInterval(timer));
async function save() {
  if (!loaded.value || busy.value) return;
  for (const { key } of providers) fieldErrors[key] = policy[key].enabled && !configured(key)
    ? '请先在上方保存该网盘的登录凭据，再启用转存。'
    : providerError(key, policy[key]);
  if (fieldErrors.quark || fieldErrors.baidu) {
    document.getElementById(fieldErrors.quark ? 'delivery-quark' : 'delivery-baidu')?.focus();
    return;
  }
  busy.value = true; message.value = ''; error.value = false;
  let deliverySaved = false;
  try {
    const result = await apiFetch<{ data: DeliveryPolicy }>('/api/settings/link-delivery', { method: 'PUT', body: payload() });
    policy.revision = result.data.revision; deliverySaved = true;
    await apiFetch('/api/settings/link-check', { method: 'PUT', body: { ...check } });
    saved.value = snapshot();
    message.value = '功能设置已保存；不会自动恢复应急暂停的到期清理。';
    void refreshStatus();
  } catch (e) { error.value = true; message.value = `${deliverySaved ? '转存设置已保存，但检测设置未保存。' : ''}${apiErrorMessage(e, '保存失败，请检查配置后重试。')}`; }
  finally { busy.value = false; }
}
</script>
<template>
  <section class="delivery-settings" aria-labelledby="delivery-title">
    <header class="delivery-heading"><div><h3 id="delivery-title">功能设置</h3><p>保存登录凭据不会自动开启转存；开关修改需点击“保存功能设置”后生效。</p></div></header>
    <aside class="runtime-status" aria-live="polite">
      <div><strong>{{ runtimeLabel }}</strong><p>转存仅在用户复制或打开链接时触发；本地关联自动同步，后台巡检由下方独立开关控制。</p><p v-if="monitor && !monitor.workers.links.enabled">到期清理处于应急暂停状态，请在运行监控中恢复；不影响点击取链和本地关联。</p><p v-else>已有转存产物到期后自动清理，不受转存或巡检开关影响。</p><p v-if="monitor">本地待关联 {{ monitor.links.syncPending.toLocaleString() }} 条 · 待清理 {{ monitor.links.queues.cleanup.queued }} 条</p></div>
      <RouterLink to="/admin/monitor">查看运行监控</RouterLink>
    </aside>
    <p v-if="loading" role="status">正在读取功能设置…</p>
    <Button v-else-if="!loaded" type="button" variant="outline" @click="load">重试加载</Button>
    <form v-if="loaded" class="delivery-form" @submit.prevent="save">
      <div class="delivery-grid">
        <section v-for="p in providers" :key="p.key" :id="`delivery-${p.key}`" class="delivery-provider" tabindex="-1" :aria-labelledby="`delivery-title-${p.key}`">
          <div class="switch-row"><div><h4 :id="`delivery-title-${p.key}`">{{ p.name }}按需转存</h4><p>{{ policy[p.key].enabled ? '启用：用户获取链接时转存并生成分享' : '停用：不创建新的转存和分享' }}</p></div><label class="switch-touch" :for="`delivery-switch-${p.key}`"><Switch :id="`delivery-switch-${p.key}`" :model-value="policy[p.key].enabled" :aria-labelledby="`delivery-title-${p.key}`" :disabled="busy" @update:model-value="enable(p.key, $event)" /></label></div>
          <p v-if="!configured(p.key)" class="settings-note">尚未配置登录凭据，请先在上方保存 Cookie。</p>
          <div v-if="policy[p.key].enabled" class="provider-fields">
            <div class="directory-field"><span :id="`directory-label-${p.key}`">项目专用目录 <span aria-hidden="true">*</span></span><div class="directory-value"><span>{{ directoryNames[p.key] || (policy[p.key].targetDir ? (p.key === 'quark' ? '已配置项目专用目录' : policy[p.key].targetDir) : '尚未选择目录') }}</span><Button type="button" variant="outline" :disabled="busy || !configured(p.key)" :aria-labelledby="`directory-button-${p.key} directory-label-${p.key}`" @click="picker = p.key"><span :id="`directory-button-${p.key}`">选择目录</span></Button></div></div>
            <label class="settings-field" :for="`retention-${p.key}`"><span>保留时间（小时） *</span><Input :id="`retention-${p.key}`" v-model="policy[p.key].hours" type="number" min="0.016666666666666666" max="720" step="any" required :disabled="busy" /><small>默认 24 小时，到期停止交付并排队清理。</small></label>
            <details class="settings-advanced"><summary>高级设置</summary><div class="advanced-fields">
              <label class="settings-field" :for="`dir-manual-${p.key}`"><span>{{ p.key === 'quark' ? '目录 fid（可手动填写）' : '目录路径（可手动填写）' }}</span><Input :id="`dir-manual-${p.key}`" :model-value="policy[p.key].targetDir || ''" :disabled="busy" :placeholder="p.key === 'quark' ? '非根目录的文件夹 fid' : '/pansou'" @update:model-value="policy[p.key].targetDir = String($event); directoryNames[p.key] = ''" /></label>
              <label class="settings-field" :for="`remaining-${p.key}`"><span>临近到期停止交付（秒）</span><Input :id="`remaining-${p.key}`" v-model.number="policy[p.key].deliveryMinRemainingSeconds" type="number" min="0" step="1" :disabled="busy" /></label>
              <label class="settings-field" :for="`share-days-${p.key}`"><span>平台分享期限</span><AdminSelect :id="`share-days-${p.key}`" v-model="policy[p.key].platformShareDays" :disabled="busy"><option :value="1">1 天</option><option :value="7">7 天</option><option :value="30">30 天</option></AdminSelect></label>
            </div></details>
          </div>
          <p v-if="fieldErrors[p.key]" class="settings-error" role="alert">{{ fieldErrors[p.key] }}</p>
        </section>
      </div>
      <section class="delivery-provider">
        <div class="switch-row"><div><h4 id="check-title">后台有效性检测</h4><p>{{ check.enabled ? '启用：在后台批量核验链接，不触发转存' : '停用：不执行后台批量检测' }}。用户获取链接时仍可能按需核验。</p></div><label class="switch-touch" for="check-enabled"><Switch id="check-enabled" v-model="check.enabled" aria-labelledby="check-title" :disabled="busy" /></label></div>
        <details v-if="check.enabled" class="settings-advanced"><summary>检测频率与缓存（高级）</summary><div class="advanced-fields check-fields">
          <label class="settings-field" for="check-budget"><span>每个平台每日检测上限</span><Input id="check-budget" v-model.number="check.dailyBudget" type="number" min="1" max="100000" step="1" :disabled="busy" required /></label>
          <label class="settings-field" for="check-interval"><span>检测间隔（秒）</span><Input id="check-interval" v-model.number="check.intervalSeconds" type="number" min="2" max="3600" step="1" :disabled="busy" required /></label>
          <label class="settings-field" for="check-valid"><span>有效结果缓存（秒）</span><Input id="check-valid" v-model.number="check.validSeconds" type="number" min="60" max="2592000" step="1" :disabled="busy" required /></label>
          <label class="settings-field" for="check-invalid"><span>失效结果缓存（秒）</span><Input id="check-invalid" v-model.number="check.invalidSeconds" type="number" min="60" max="2592000" step="1" :disabled="busy" required /></label>
        </div></details>
      </section>
      <p class="settings-note">关闭转存不删除既有产物，也不取消到期清理。只清理本流程创建的子目录，不清空账号回收站；登录失效或限频可能延迟清理。</p>
      <footer class="settings-footer"><span>{{ dirty ? '有未保存的修改' : '设置已与服务端同步' }}</span><Button type="submit" :disabled="busy || !dirty">{{ busy ? '保存中…' : '保存功能设置' }}</Button></footer>
    </form>
    <p v-if="message" :class="{ 'settings-error': error }" :role="error ? 'alert' : 'status'">{{ message }}</p>
    <CloudDirectoryPicker v-if="picker" :provider="picker" @close="picker = null" @select="selectDirectory" />
  </section>
</template>
<style scoped>
@layer components {
.delivery-settings { display: grid; gap: 20px; margin-top: 24px; border-top: 1px solid var(--border); padding-top: 24px; color: var(--foreground); font-size: 14px; line-height: 1.6; }
.delivery-settings h3, .delivery-settings h4, .delivery-settings p { margin: 0; }
.delivery-settings h3 { font-size: 18px; font-weight: 600; }
.delivery-settings h4 { font-size: 15px; font-weight: 600; }
.delivery-heading p, .switch-row p, .settings-note, .settings-field small, .settings-footer span { color: var(--muted-foreground); }
.runtime-status { display: flex; justify-content: space-between; gap: 16px; padding: 16px; border: 1px solid var(--border); border-radius: 10px; background: var(--muted); }
.runtime-status p { margin-top: 4px; color: var(--muted-foreground); }
.runtime-status a { flex-shrink: 0; text-decoration: underline; text-underline-offset: 3px; min-height: 44px; display: flex; align-items: center; }
.delivery-form { display: grid; gap: 16px; }
.delivery-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.delivery-provider { min-width: 0; display: grid; align-content: start; gap: 16px; padding: 20px; border: 1px solid var(--border); border-radius: 10px; background: var(--card); }
.switch-row { display: flex; gap: 16px; align-items: center; justify-content: space-between; min-height: 44px; }
.switch-touch { display: flex; flex-shrink: 0; justify-content: center; align-items: center; padding: 13px; min-height: 44px; min-width: 58px; cursor: pointer; }
.provider-fields, .advanced-fields, .settings-field { display: grid; gap: 8px; }
.provider-fields { gap: 16px; }
.settings-field input, .settings-field :deep([data-slot=select-trigger]), .directory-value button, .settings-footer button { min-height: 44px; }
.settings-field small { font-size: 12px; }
.directory-field { display: grid; gap: 8px; }
.directory-value { display: flex; align-items: center; gap: 8px; }
.directory-value > span { min-width: 0; flex: 1; overflow-wrap: anywhere; padding: 10px 12px; background: var(--muted); border-radius: 6px; }
.directory-value button { flex-shrink: 0; }
.settings-advanced summary { display: flex; align-items: center; min-height: 44px; cursor: pointer; color: var(--muted-foreground); }
.settings-advanced summary::before { content: '›'; margin-right: 8px; }
.settings-advanced[open] summary::before { content: '⌄'; }
.settings-advanced summary:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; border-radius: 4px; }
.advanced-fields { gap: 16px; margin-top: 8px; }
.check-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.settings-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; border-top: 1px solid var(--border); padding-top: 16px; }
.settings-error { color: var(--destructive); }
@media (max-width: 900px) { .delivery-grid { grid-template-columns: 1fr; } }
@media (max-width: 600px) { .runtime-status { flex-direction: column; gap: 4px; } .delivery-provider { padding: 16px; } .check-fields { grid-template-columns: 1fr; } .settings-footer { flex-wrap: wrap; } }
}
</style>
