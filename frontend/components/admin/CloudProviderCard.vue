<script setup lang="ts">
import { computed } from 'vue';
import { Cloud, QrCode, CircleAlert, CircleCheck, LoaderCircle } from '@lucide/vue';
import { accountStatus, authReason, type AccountCheckFeedback, type CloudAccount } from '../../lib/cloudAccounts';
import { directoryLabel, durationLabel, providerName, type ProviderKey, type ProviderPolicy } from '../../lib/linkPolicy';
import { Button } from './ui/button';
import AdminRowActions from './AdminRowActions.vue';
const props = defineProps<{ provider: ProviderKey; account?: CloudAccount; policy: ProviderPolicy; configured: boolean; busy: boolean; disabled: boolean; feedback?: AccountCheckFeedback }>();
const emit = defineEmits<{ qrSettings: []; configure: []; qr: []; import: []; check: []; replace: []; disconnect: [] }>();
function date(value?: string) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '未记录'; }
function maintenance(account: CloudAccount) {
  if (account.refreshable) return '自动续期';
  if (props.provider === 'baidu' || props.provider === 'quark') return 'Cookie 维护';
  return props.provider === 'xunlei' ? '手动维护' : '仅检测';
}
const issue = computed(() => props.account?.lastErrorCode
  ? authReason(props.account.lastErrorCode)
  : props.policy.enabled && !props.configured ? '验证账号后启用转存' : '');
function transferValue(policy: ProviderPolicy) {
  return policy.enabled ? `保留 ${durationLabel(policy.retentionSeconds)}` : '未开启';
}
function checkValue(policy: ProviderPolicy) {
  return `${policy.checkIntervalSeconds} 秒 / 次 · ${policy.checkDailyBudget.toLocaleString()} 次 / 日`;
}
</script>
<template>
  <article class="provider-card" :aria-busy="busy">
    <header class="provider-head">
      <span class="provider-icon"><Cloud :size="20" aria-hidden="true" /></span>
      <h2><a v-if="account?.officialUrl" class="provider-title-link" :href="account.officialUrl" target="_blank" rel="noopener noreferrer" :title="providerName(provider) + '官网（新标签页）'">{{ providerName(provider) }}</a><template v-else>{{ providerName(provider) }}</template></h2>
      <span class="provider-badge" :class="{ 'provider-badge-alert': account?.status === 'reauthorization_required', 'provider-badge-ready': configured }">{{ account ? accountStatus(account.status) : '未连接' }}</span>
    </header>

    <dl class="provider-facts">
      <div><dt>账号</dt><dd>{{ account?.displayName || (account?.configured ? '待验证身份' : '未连接') }}<span v-if="account?.subjectId" class="provider-note"> · {{ account.subjectId }}</span></dd></div>
      <div v-if="account?.storageScope"><dt>存储</dt><dd>{{ account.storageScope }}</dd></div>
      <div><dt>验证</dt><dd class="provider-note">{{ account?.lastVerifiedAt ? date(account.lastVerifiedAt) : '尚未验证' }}<template v-if="account?.configured"> · {{ maintenance(account) }}</template></dd></div>
      <div v-if="account?.expiresAt"><dt>到期</dt><dd>{{ date(account.expiresAt) }}</dd></div>
    </dl>

    <div class="provider-policy">
      <div class="policy-row">
        <span class="policy-label">转存</span>
        <span class="policy-value" :title="policy.enabled ? directoryLabel(policy) : undefined"><span v-if="policy.enabled" class="policy-dot" aria-hidden="true"></span>{{ transferValue(policy) }}</span>
        <Button variant="ghost" size="sm" :disabled="busy || disabled" @click="emit('configure')">配置</Button>
      </div>
      <div class="policy-row">
        <span class="policy-label">检测</span>
        <span class="policy-value">{{ checkValue(policy) }}</span>
      </div>
    </div>

    <p v-if="feedback" class="provider-feedback" :data-state="feedback.state" :role="feedback.state === 'error' ? 'alert' : 'status'"><component :is="feedback.state === 'checking' ? LoaderCircle : feedback.state === 'success' ? CircleCheck : CircleAlert" :size="14" aria-hidden="true" /><span>{{ feedback.message }}</span></p>
    <p v-else-if="issue" class="provider-error" role="status"><CircleAlert :size="14" aria-hidden="true" /><span>{{ issue }}</span></p>

    <p v-if="provider === 'xunlei' && account?.qrSupported" class="provider-note">实验扫码：需验证官方客户端兼容性；设备验证失败时请使用高级导入。</p>

    <footer class="provider-footer">
      <div class="provider-actions">
        <Button v-if="account?.qrSupported" size="sm" :disabled="busy || disabled" @click="emit('qr')"><QrCode :size="15" aria-hidden="true" />{{ account.configured ? '重新连接' : '扫码连接' }}</Button>
        <Button v-else size="sm" :disabled="busy || disabled" @click="emit('import')">导入凭证</Button>
        <Button v-if="account?.configured" variant="outline" size="sm" :disabled="busy || disabled" @click="emit('check')"><LoaderCircle v-if="feedback?.state === 'checking'" :size="14" class="check-spinner" aria-hidden="true" />{{ feedback?.state === 'checking' ? '验证中…' : '验证账号' }}</Button>
        <AdminRowActions :label="providerName(provider) + '更多操作'">
          <Button v-if="provider === 'xunlei'" variant="ghost" :disabled="busy || disabled" @click="emit('qrSettings')">实验扫码设置</Button>
          <Button v-if="account?.qrSupported" variant="ghost" :disabled="busy || disabled" @click="emit('import')">高级导入</Button>
          <Button v-if="account?.configured" variant="ghost" :disabled="busy || disabled" @click="emit('replace')">更换账号</Button>
          <Button v-if="account?.configured" variant="ghost" :disabled="busy || disabled" @click="emit('disconnect')">断开连接</Button>
          <Button v-if="!account?.qrSupported && !account?.configured" variant="ghost" :disabled="busy || disabled" @click="emit('configure')">转存与检测配置</Button>
        </AdminRowActions>
      </div>
    </footer>
  </article>
</template>
<style scoped>
@layer components {
.provider-card { display: flex; flex-direction: column; gap: 18px; min-width: 0; padding: 20px; border: 1px solid var(--border); border-radius: 10px; background: var(--card); box-shadow: 0 1px 2px rgb(0 0 0 / 0.025); }
.provider-head { display: flex; align-items: center; gap: 10px; }
.provider-icon { display: grid; place-items: center; width: 36px; height: 36px; flex-shrink: 0; background: var(--muted); border: 1px solid var(--border); border-radius: 8px; }
.provider-head h2 { margin: 0; font-size: 15px; font-weight: 600; }
.provider-title-link { color: inherit; text-decoration: none; border-radius: 3px; text-underline-offset: 4px; }
.provider-title-link:hover { text-decoration: underline; }
.provider-title-link:focus-visible { outline: 2px solid var(--ring); outline-offset: 4px; }
.provider-badge { margin-left: auto; padding: 2px 7px; border: 1px solid var(--border); border-radius: 5px; color: var(--muted-foreground); font-size: 11px; white-space: nowrap; }
.provider-badge-alert { color: var(--destructive); border-color: color-mix(in srgb, var(--destructive) 20%, transparent); background: color-mix(in srgb, var(--destructive) 4%, var(--card)); }
.provider-badge-ready { color: #15803d; border-color: #bbf7d0; background: #f0fdf4; }
.provider-facts { display: grid; gap: 8px; margin: 0; font-size: 12px; line-height: 1.6; }
.provider-facts > div { display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 12px; }
.provider-facts dt, .provider-note { color: var(--muted-foreground); }
.provider-facts dd { margin: 0; overflow-wrap: anywhere; }
.provider-policy { display: grid; gap: 4px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 6px; background: color-mix(in srgb, var(--muted) 55%, var(--card)); }
.policy-row { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; align-items: center; gap: 12px; min-height: 28px; }
.policy-label { font-size: 12px; color: var(--muted-foreground); }
.policy-value { font-size: 12px; min-width: 0; overflow-wrap: anywhere; }
.policy-dot { display: inline-block; width: 5px; height: 5px; margin: 0 6px 2px 0; border-radius: 50%; background: #16a34a; }
.provider-error, .provider-feedback { display: flex; align-items: flex-start; gap: 6px; margin: -4px 0 0; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.provider-error, .provider-feedback[data-state=error] { color: var(--destructive); }
.provider-feedback[data-state=checking] { color: var(--muted-foreground); }
.provider-feedback[data-state=success] { color: #15803d; }
.provider-error svg, .provider-feedback svg { margin-top: 3px; }
.check-spinner, .provider-feedback[data-state=checking] svg { animation: check-spin 1s linear infinite; }
@keyframes check-spin { to { transform: rotate(360deg); } }
@media(prefers-reduced-motion:reduce) { .check-spinner, .provider-feedback[data-state=checking] svg { animation: none; } }
.provider-footer { margin-top: auto; }
.provider-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.provider-actions > :last-child { margin-left: auto; }
@media(max-width:600px) { .provider-card { padding: 16px; } }
}
</style>
