<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import { providerError, providerName, type ProviderForm, type ProviderKey } from '../../lib/linkPolicy';
import AdminDialog from './AdminDialog.vue';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Switch } from './ui/switch';
import AdminSelect from './AdminSelect.vue';
import CloudDirectoryBrowser from './CloudDirectoryBrowser.vue';
const props = defineProps<{ provider: ProviderKey; policy: ProviderForm; configured: boolean; busy: boolean }>();
const emit = defineEmits<{ close: []; save: [payload: ProviderForm] }>();
const form = reactive<ProviderForm>({ ...props.policy });
const picking = ref(false);
const fieldError = ref('');
watch(() => form.enabled, (value) => { if (value && form.hours === '') form.hours = 24; fieldError.value = ''; });
function selectDirectory(dir: string, name: string) {
  form.targetDir = dir; form.targetDirName = name; picking.value = false; fieldError.value = '';
}
function save() {
  fieldError.value = providerError(props.provider, form);
  if (fieldError.value) return;
  emit('save', { ...form });
}
</script>
<template>
  <AdminDialog :title="`${providerName(provider)} · 转存与检测`" :description="picking ? '选择项目专用文件夹（只读取，不会创建或删除文件）。' : '按需转存目录、清理时间与检测参数。'" wide :busy="busy" @close="emit('close')">
    <div v-if="picking" class="policy-picking">
      <CloudDirectoryBrowser :provider="provider" @select="selectDirectory" />
      <footer class="policy-footer"><Button type="button" variant="outline" @click="picking = false">返回配置</Button></footer>
    </div>
    <div v-else class="policy-dialog">
      <section class="policy-section" aria-labelledby="policy-delivery">
        <div class="policy-switch">
          <div><h3 id="policy-delivery">按需转存</h3><p>{{ form.enabled ? '复制或打开链接时转存并生成分享。' : '只返回原链接。' }}</p></div>
          <label class="policy-switch-touch" :for="`policy-enabled-${provider}`"><Switch :id="`policy-enabled-${provider}`" :model-value="form.enabled" :disabled="busy || !configured" aria-labelledby="policy-delivery" @update:model-value="form.enabled = $event" /></label>
        </div>
        <p v-if="!configured" class="policy-note">账号未验证可用，请先连接并检查登录态。</p>
        <div v-if="form.enabled" class="policy-fields">
          <div class="policy-field">
            <span id="policy-dir-label">项目专用目录 <span aria-hidden="true">*</span></span>
            <div class="policy-directory">
              <span class="policy-directory-value">{{ form.targetDirName || (form.targetDir ? (provider === 'baidu' ? form.targetDir : '已配置项目专用目录') : '尚未选择目录') }}</span>
              <Button type="button" variant="outline" :disabled="busy || !configured" aria-labelledby="policy-dir-button policy-dir-label" @click="picking = true"><span id="policy-dir-button">选择目录</span></Button>
            </div>
            <small>需为非根目录文件夹，转存产物写在这里。</small>
          </div>
          <label class="policy-field" :for="`policy-retention-${provider}`"><span>清理时间（小时） <span aria-hidden="true">*</span></span><Input :id="`policy-retention-${provider}`" v-model="form.hours" type="number" min="0.016666666666666666" max="720" step="any" required :disabled="busy" /><small>到期后停止交付并排队清理。</small></label>
          <details class="policy-advanced"><summary>高级设置</summary><div class="policy-advanced-fields">
            <label class="policy-field" :for="`policy-dir-manual-${provider}`"><span>{{ provider === 'baidu' ? '目录路径（可手动填写）' : '目录 ID（可手动填写）' }}</span><Input :id="`policy-dir-manual-${provider}`" :model-value="form.targetDir || ''" :disabled="busy" :placeholder="provider === 'baidu' ? '/pansou' : '非根目录的文件夹 ID'" @update:model-value="form.targetDir = String($event); form.targetDirName = ''" /></label>
            <label class="policy-field" :for="`policy-remaining-${provider}`"><span>临近到期停止交付（秒）</span><Input :id="`policy-remaining-${provider}`" v-model.number="form.deliveryMinRemainingSeconds" type="number" min="0" step="1" :disabled="busy" /></label>
            <label class="policy-field" :for="`policy-share-days-${provider}`"><span>平台分享期限</span><AdminSelect :id="`policy-share-days-${provider}`" v-model="form.platformShareDays" :disabled="busy"><option :value="1">1 天</option><option :value="7">7 天</option><option :value="30">30 天</option></AdminSelect></label>
          </div></details>
        </div>
      </section>
      <section class="policy-section" aria-labelledby="policy-check">
        <div class="policy-check-heading"><h3 id="policy-check">有效性检测参数</h3><p>启停与调度在「链接后台处理」控制。</p></div>
        <div class="policy-check-fields">
          <label class="policy-field" :for="`policy-interval-${provider}`"><span>检测间隔（秒）</span><Input :id="`policy-interval-${provider}`" v-model.number="form.checkIntervalSeconds" type="number" min="2" max="3600" step="1" :disabled="busy" required /></label>
          <label class="policy-field" :for="`policy-budget-${provider}`"><span>每个平台每日检测上限</span><Input :id="`policy-budget-${provider}`" v-model.number="form.checkDailyBudget" type="number" min="1" max="100000" step="1" :disabled="busy" required /></label>
          <label class="policy-field" :for="`policy-valid-${provider}`"><span>有效结果缓存（秒）</span><Input :id="`policy-valid-${provider}`" v-model.number="form.checkValidSeconds" type="number" min="60" max="2592000" step="1" :disabled="busy" required /></label>
          <label class="policy-field" :for="`policy-invalid-${provider}`"><span>失效结果缓存（秒）</span><Input :id="`policy-invalid-${provider}`" v-model.number="form.checkInvalidSeconds" type="number" min="60" max="2592000" step="1" :disabled="busy" required /></label>
        </div>
      </section>
      <p v-if="fieldError" class="policy-error" role="alert">{{ fieldError }}</p>
      <footer class="policy-footer">
        <Button type="button" :disabled="busy" @click="save">{{ busy ? '保存中…' : '保存' }}</Button>
      </footer>
    </div>
  </AdminDialog>
</template>
<style scoped>
@layer components {
.policy-dialog { display: grid; gap: 20px; padding: 24px; color: var(--foreground); font-size: 14px; line-height: 1.6; min-width: 0; }
.policy-picking { display: grid; gap: 16px; padding: 24px; color: var(--foreground); font-size: 14px; line-height: 1.6; min-width: 0; }
.policy-dialog h3, .policy-dialog p { margin: 0; }
.policy-dialog h3 { font-size: 15px; font-weight: 600; }
.policy-section { display: grid; gap: 16px; padding: 20px; border: 1px solid var(--border); border-radius: 10px; background: var(--card); min-width: 0; }
.policy-switch { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 44px; }
.policy-switch p, .policy-check-heading p, .policy-note, .policy-field small { color: var(--muted-foreground); }
.policy-switch-touch { display: flex; align-items: center; justify-content: center; flex-shrink: 0; min-height: 44px; min-width: 58px; padding: 13px; cursor: pointer; }
.policy-fields, .policy-field, .policy-advanced-fields { display: grid; gap: 8px; }
.policy-fields { gap: 16px; }
.policy-field input, .policy-field :deep([data-slot=select-trigger]), .policy-footer button, .policy-directory button { min-height: 44px; }
.policy-field small { font-size: 12px; }
.policy-directory { display: flex; align-items: center; gap: 8px; }
.policy-directory-value { flex: 1; min-width: 0; padding: 10px 12px; background: var(--muted); border-radius: 6px; overflow-wrap: anywhere; }
.policy-directory button { flex-shrink: 0; }
.policy-advanced summary { display: flex; align-items: center; min-height: 44px; cursor: pointer; color: var(--muted-foreground); }
.policy-advanced summary::before { content: '›'; margin-right: 8px; }
.policy-advanced[open] summary::before { content: '⌄'; }
.policy-advanced summary:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; border-radius: 4px; }
.policy-advanced-fields { gap: 16px; margin-top: 8px; }
.policy-check-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.policy-error { color: var(--destructive); overflow-wrap: anywhere; }
.policy-footer { display: flex; align-items: center; justify-content: flex-end; gap: 12px; }
@media (max-width: 600px) { .policy-dialog { padding: 16px; } .policy-section { padding: 16px; } .policy-check-fields { grid-template-columns: 1fr; } .policy-footer button { flex: 1 1 auto; } }
}
</style>
