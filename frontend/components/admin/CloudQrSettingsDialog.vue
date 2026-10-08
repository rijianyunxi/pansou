<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { Button } from './ui/button';
import { Switch } from './ui/switch';
import { Textarea } from './ui/textarea';
import AdminDialog from './AdminDialog.vue';
import { qrSettingsPayload, type QrSettings, type QrSettingsUpdate } from '../../lib/cloudAccounts';
const props = defineProps<{ settings: QrSettings; busy: boolean; error?: string }>();
const emit = defineEmits<{ close: []; save: [value: QrSettingsUpdate] }>();
const enabled = ref(props.settings.enabled), context = ref(''), clearContext = ref(false), fieldError = ref('');
function save() {
  fieldError.value = '';
  try { emit('save', qrSettingsPayload(props.settings, enabled.value, context.value, clearContext.value)); }
  catch (e) { fieldError.value = e instanceof Error ? e.message : '上下文格式无效'; }
}
onBeforeUnmount(() => { context.value = ''; });
</script>
<template>
  <AdminDialog title="迅雷 · 实验扫码设置" description="功能设置保存在数据库中，保存立即生效，不需要修改环境变量或重启。" :busy="busy" @close="emit('close')">
    <form class="qr-settings-form" @submit.prevent="save">
      <p class="qr-settings-hint">这是未完成真实账号验收的实验接入，不支持自动获取或续期 captcha，也不会绕过官方验证。启用前需要核实官方客户端与设备上下文。</p>
      <div class="qr-settings-switch"><label for="xunlei-qr-enabled">启用实验扫码</label><Switch id="xunlei-qr-enabled" v-model="enabled" :disabled="busy || clearContext" /></div>
      <p class="qr-settings-hint">{{ settings.configured ? '已保存客户端上下文。为保护凭证不会回显；留空保留原配置。' : '尚未保存客户端上下文。启用前请填写一次。' }}</p>
      <label for="xunlei-qr-context">客户端上下文 JSON（高级设置）</label>
      <p id="xunlei-qr-context-hint" class="qr-settings-hint">必须包含同一官方会话的 client_id、device_id、captcha_token；可选 client_secret、signature、device_sign、ui_client_key。不包含 access_token，也不接受自定义地址。请勿将这些信息发给他人。</p>
      <Textarea id="xunlei-qr-context" v-model="context" rows="6" maxlength="65536" autocomplete="off" autocapitalize="off" :spellcheck="false" :disabled="busy || clearContext" aria-describedby="xunlei-qr-context-hint" placeholder="留空不修改已保存的上下文" />
      <div v-if="settings.configured" class="qr-settings-switch"><label for="xunlei-qr-clear">关闭并清除保存的上下文</label><Switch id="xunlei-qr-clear" :model-value="clearContext" :disabled="busy" @update:model-value="clearContext = $event; if ($event) { enabled = false; context = ''; }" /></div>
      <p class="qr-settings-hint">保存会取消尚未完成的迅雷扫码会话；不会断开已连接账号或删除网盘文件。此上下文与账号凭证一样保存在数据库中，请保护数据库及备份。</p>
      <p v-if="fieldError || error" class="qr-settings-error" role="alert">{{ fieldError || error }}</p>
      <footer><Button variant="outline" type="button" :disabled="busy" @click="emit('close')">取消</Button><Button type="submit" :disabled="busy">{{ busy ? '保存中…' : '保存设置' }}</Button></footer>
    </form>
  </AdminDialog>
</template>
<style scoped>
@layer components {
.qr-settings-form { display: grid; gap: 14px; padding: 24px; }
.qr-settings-switch { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.qr-settings-hint { color: var(--muted-foreground); font-size: 12px; line-height: 1.7; margin: 0; }
.qr-settings-error { color: var(--destructive); font-size: 13px; margin: 0; }
.qr-settings-form footer { display: flex; justify-content: flex-end; gap: 8px; }
}
</style>
