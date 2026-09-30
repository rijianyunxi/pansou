<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import AdminDialog from './AdminDialog.vue';
import AdminCheckbox from './AdminCheckbox.vue';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Card } from './ui/card';
import { useAdminConfirm } from '@/composables/admin/useAdminConfirm';
import { mutateCloud, readCloud, queryCloudOperation } from '@/composables/admin/useCloudDrive';
import { apiErrorMessage } from '@/src/appRuntime';
import type { DriveResult, DriveFile } from '@/types/cloudDrive';
const props = defineProps<{ initial?: { url: string; password?: string | null } }>();
const emit = defineEmits<{ close: []; changed: [] }>();
const { confirm } = useAdminConfirm();
const url = ref(props.initial?.url || '');
const password = ref(props.initial?.password || '');
const toDir = ref('');
const dedup = ref(true), autoShare = ref(true), busy = ref(false), error = ref(''), progress = ref('');
const result = ref<DriveResult | null>(null), operationKey = ref(''), lookupKey = ref('');
let controller: AbortController | undefined;
let mutationSignature = '', deletion: Record<string, unknown> & { requestKey: string } | undefined;
const provider = computed(() => { try { const host = new URL(url.value).hostname; return host === 'pan.quark.cn' ? 'quark' : host === 'pan.baidu.com' ? 'baidu' : null; } catch { return null; } });
const fields = computed(() => ({ url: url.value.trim(), password: password.value.trim() || undefined, toDir: toDir.value.trim() || undefined, autoShare: autoShare.value, dedup: dedup.value }));
const rows = computed<DriveFile[]>(() => Array.isArray(result.value?.files) ? result.value.files : result.value?.matched || []);
const label = computed(() => { const r = result.value; if (!r) return ''; if (r.status === 'running') return '操作仍在运行'; if (r.status === 'uncertain') return '操作结果未确认'; if (r.status === 'valid') return '链接有效'; if (r.status === 'invalid') return '链接已失效'; if (r.status === 'unknown') return '未能确认链接状态'; if (r.deletedCount !== undefined) return '云端已删除 ' + r.deletedCount + ' 项'; if (r.mode === 'reused') return '资源已存在，没有重复转存'; if (r.mode === 'saved') return '已转存 ' + r.count + ' 项'; return r.alreadyExists ? '检测到已有资源' : '未检测到已有资源'; });
watch(fields, () => { result.value = null; deletion = undefined; }, { deep: true });
onBeforeUnmount(() => controller?.abort());
function keyFor(action: string, payload: unknown) {
 const identity = JSON.stringify({ action, payload });
 if (identity !== mutationSignature || !operationKey.value) { mutationSignature = identity; operationKey.value = crypto.randomUUID(); }
 return operationKey.value;
}
function pending(key: string) { operationKey.value = key; progress.value = '操作已受理，正在查询完成状态，请不要重复提交。'; }
async function newOperation() {
 if (busy.value) return;
 if (operationKey.value && !await confirm('新操作会使用新的编号。请先确认旧操作已经结束且云端状态符合预期，尤其不要在结果未确认时重复转存或删除。确定开始新操作？')) return;
 lookupKey.value = operationKey.value; operationKey.value = ''; mutationSignature = ''; deletion = undefined; result.value = null; error.value = '';
}
async function run(action: 'check' | 'save' | 'existing' | 'delete' | 'lookup') {
 if (busy.value) return;
 busy.value = true; error.value = ''; progress.value = '';
 controller = new AbortController();
 try {
  const signal = controller.signal;
  if (action === 'lookup') { result.value = await queryCloudOperation(lookupKey.value.trim() || operationKey.value, signal); if (result.value.status === 'running') progress.value = '该操作仍在运行，可稍后再次查询。'; return; }
  if (!provider.value) throw new Error('请输入百度或夸克网盘的完整分享链接。');
  if (action === 'check') { result.value = await readCloud('check', { url: fields.value.url, password: fields.value.password }, signal); return; }
  if (action === 'delete') {
   if (!deletion) {
    const preview = await readCloud('delete-preview', { url: fields.value.url, password: fields.value.password }, signal);
    const files = Array.isArray(preview.files) ? preview.files : [];
    if (!await confirm('已核实该分享属于当前账号。将删除 ' + preview.count + ' 个顶层条目：' + files.slice(0, 8).map(f => f.name + (f.isDir ? '（整个目录）' : '')).join('、') + '。目录内全部内容也会删除；盘搜记录保留。确定继续？')) return;
    deletion = { url: fields.value.url, password: fields.value.password, confirmationToken: preview.confirmationToken, requestKey: keyFor('delete', { url: fields.value.url, password: fields.value.password }) };
   }
   result.value = await mutateCloud('/api/admin/cloud-drive/delete', deletion, signal, pending);
  } else {
   const body = action === 'existing' ? { url: fields.value.url, password: fields.value.password, toDir: fields.value.toDir, autoShare: fields.value.autoShare } : fields.value;
   if (action === 'save' && !await confirm('将把分享内容转存到当前账号的目标目录。' + (dedup.value ? '已存在文件会复用，仅转存缺失条目。' : '未开启去重，可能产生重复文件。') + '是否继续？')) return;
   if (action === 'existing' && body.autoShare && !await confirm('已勾选创建新分享，检测到已存在文件时会为这些文件生成分享链接。是否继续？')) return;
   if (action === 'existing' && !body.autoShare) result.value = await readCloud('existing', body, signal);
   else result.value = await mutateCloud('/api/admin/cloud-drive/' + action, { ...body, requestKey: keyFor(action, body) }, signal, pending);
  }
  emit('changed');
 } catch (e: any) { if (e?.name !== 'AbortError') { error.value = apiErrorMessage(e); const status = e?.data?.data?.status; if (status === 'failed' || status === 'uncertain') result.value = { status }; } }
 finally { busy.value = false; progress.value = ''; }
}
</script>
<template>
 <AdminDialog title="网盘工具" description="百度 / 夸克原生检测、转存与云端删除。Cookie 仅从后端配置读取。" drawer :busy="busy" @close="emit('close')">
  <div class="admin-dialog-form">
   <div class="admin-form-fields drive-fields">
    <p class="drive-help">仅操作你有权处理的资源。检测失败不等于链接失效；云端删除不会删除盘搜里的记录。账号登录态在「系统设置 → 云端操作」维护。</p>
    <label>分享链接<Input v-model="url" :disabled="busy" type="url" placeholder="https://pan.quark.cn/s/… 或 https://pan.baidu.com/s/1…" /></label>
    <div class="drive-grid">
     <label>提取码<Input v-model="password" :disabled="busy" placeholder="链接已带提取码时可留空" /></label>
     <label>{{ provider === 'quark' ? '目标目录 fid' : '目标目录路径' }}<Input v-model="toDir" :disabled="busy" :placeholder="provider === 'quark' ? '根目录填 0；子目录填 fid' : '根目录 /；子目录 /电影'" /></label>
    </div>
    <label class="drive-choice"><AdminCheckbox v-model="dedup" :disabled="busy" />转存时去重，只保存缺失文件</label>
    <p class="drive-help">去重仅比较文件；目录不按名称或大小直接复用，避免遗漏目录内不同内容。</p>
    <label class="drive-choice"><AdminCheckbox v-model="autoShare" :disabled="busy" />为转存或已存在的文件创建新分享</label>
    <p v-if="error" role="alert" class="drive-error">{{ error }}</p>
    <p v-if="progress" role="status">{{ progress }}</p>
    <Card v-if="result" class="drive-result">
     <strong>{{ label }}</strong><p v-if="result.reason">{{ result.reason }}</p>
     <p v-if="result.shareError" role="alert" class="drive-error">{{ result.shareError }}。转存本身已完成，不要重复转存。</p>
     <p v-if="result.missing?.length" class="drive-help">只命中部分或尚未命中：还有 {{ result.missing.length }} 项未匹配。已生成的分享仅包含已存在条目，可用「转存」保存缺失项。</p>
     <p v-if="result.matchedCount !== undefined">复用 {{ result.matchedCount }} 项 · 新转存 {{ result.count || 0 }} 项</p>
     <template v-if="result.share"><a :href="result.share.url" target="_blank" rel="noopener noreferrer">{{ result.share.url }}</a><p v-if="result.share.password">提取码：{{ result.share.password }}</p></template>
     <ul v-if="rows.length"><li v-for="file in rows.slice(0, 100)" :key="file.id">{{ file.name }} <small>{{ file.isDir ? '目录' : file.size + ' B' }}</small></li></ul>
     <p v-if="rows.length > 100">显示前 100 项，共 {{ rows.length }} 项。</p>
    </Card>
    <div class="drive-lookup"><label>操作编号（响应丢失时用它查询，勿重复操作）<Input v-model="lookupKey" :placeholder="operationKey || 'requestKey UUID'" :disabled="busy" /></label><code v-if="operationKey">{{ operationKey }}</code><Button variant="outline" :disabled="busy || !(lookupKey || operationKey)" @click="run('lookup')">查询操作状态</Button><Button v-if="operationKey" variant="ghost" :disabled="busy" @click="newOperation">开启新操作（先核对旧操作）</Button></div>
   </div>
   <footer class="modal-actions drive-actions"><Button variant="outline" :disabled="busy" @click="run('check')">检测链接</Button><Button variant="outline" :disabled="busy" @click="run('existing')">检测已有</Button><Button :disabled="busy" @click="run('save')">转存</Button><Button variant="destructive" :disabled="busy" @click="run('delete')">云端删除</Button></footer>
  </div>
 </AdminDialog>
</template>
<style scoped>
@layer components {
 .drive-fields { display: flex; flex-direction: column; gap: 18px; }
 .drive-fields label { display: flex; flex-direction: column; gap: 8px; min-width: 0; font-size: 13px; }
 .drive-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
 .drive-fields .drive-choice { flex-direction: row; align-items: center; }
 .drive-help { color: var(--muted-foreground); font-size: 12px; line-height: 1.8; }
 .drive-error { color: var(--destructive); font-size: 13px; overflow-wrap: anywhere; }
 .drive-result { padding: 16px; min-width: 0; display: flex; flex-direction: column; gap: 10px; overflow-wrap: anywhere; }
 .drive-result ul { margin: 0; padding-left: 18px; }
 .drive-result li { margin: 6px 0; }
 .drive-result small { color: var(--muted-foreground); }
 .drive-lookup { display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--border); padding-top: 14px; }
 .drive-lookup code { font-size: 12px; overflow-wrap: anywhere; }
 .drive-actions { flex-wrap: wrap; }
 @media (max-width: 480px) { .drive-grid { grid-template-columns: 1fr; } .drive-actions > * { flex: 1 0 40%; } }
}
</style>
