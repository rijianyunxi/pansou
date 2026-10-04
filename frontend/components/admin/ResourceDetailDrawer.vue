<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount, triggerRef } from 'vue';
import { useCrawlQuery } from '@/composables/admin/useCrawlQuery';
import { apiFetch, apiErrorMessage } from '@/src/appRuntime';
import type { ManagedResource } from '@/shared/apiModels';
import ResourceDescription from '../ResourceDescription.vue';
import AdminDialog from './AdminDialog.vue';
import AdminSelect from './AdminSelect.vue';
import AdminPagination from './AdminPagination.vue';
import AdminResourceLink from './AdminResourceLink.vue';
import { Input } from './ui/input';
import { Button } from './ui/button';
import AdminStatusBadge from './AdminStatusBadge.vue';
import { RefreshCw, LoaderCircle } from '@lucide/vue';
import { CLOUD_TYPE_SHORT_LABELS } from '@/shared/cloudTypes';
import { linkObservation, type AdminResourceLinkData } from '@/lib/adminResourceLinks';
type DetailResource = Omit<ManagedResource, 'links'> & { links: AdminResourceLinkData[]; enabled?: boolean };
const props = defineProps<{ id: string; initialKey?: string }>();
const emit = defineEmits<{ close: []; changed: [] }>();
const url = computed(() => '/api/admin/resources/' + encodeURIComponent(props.id));
const { data, loading, error } = useCrawlQuery<{ resource: DetailResource | null }>(url, ref({}), 0);
const resource = computed(() => data.value?.resource);
const checking = ref(new Set<string>()), errors = ref<Record<string, string>>({});
const controllers = new Map<string, AbortController>();
onBeforeUnmount(() => { for (const controller of controllers.values()) controller.abort(); });
async function check(link: AdminResourceLinkData) {
  const key = link.linkKey;
  if (!key || !link.checkSupported || checking.value.has(key)) return;
  checking.value.add(key); errors.value[key] = '';
  const controller = new AbortController(); controllers.set(key, controller);
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await apiFetch<{ data: Partial<AdminResourceLinkData> & { message?: string } }>(url.value + '/links/check', { method: 'POST', body: { linkKey: key }, signal: controller.signal });
    Object.assign(link, response.data); triggerRef(data);
    if (response.data.validity === -1) errors.value[key] = response.data.message || '暂时无法确认，请稍后重试';
    emit('changed');
  } catch (e) { errors.value[key] = controller.signal.aborted ? '检测超时，请重试' : apiErrorMessage(e); }
  finally { clearTimeout(timeout); controllers.delete(key); checking.value.delete(key); }
}
const provider = ref(''), status = ref(''), query = ref(''), page = ref(1), pageSize = ref(20);
const links = computed(() => resource.value?.links || []);
const providers = computed(() => [...new Set(links.value.map(link => link.type))]);
const filtered = computed(() => links.value.filter(link => (!provider.value || link.type === provider.value) && (!status.value || linkObservation(link).label === status.value) && (!query.value || link.url.toLowerCase().includes(query.value.toLowerCase()))));
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize.value)));
const visible = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));
watch([provider, status, query, pageSize], () => page.value = 1);
watch([links, () => props.initialKey], () => { const index = links.value.findIndex(link => link.linkKey === props.initialKey); page.value = Math.max(1, Math.floor(index / pageSize.value) + 1); }, { immediate: true });
watch(pages, total => { page.value = Math.min(page.value, total); });
function label(type: string) { return (CLOUD_TYPE_SHORT_LABELS as Record<string, string>)[type] || type; }
</script>
<template>
 <AdminDialog title="资源详情" :description="resource?.name" drawer @close="emit('close')">
  <p v-if="loading" role="status" class="detail-feedback">正在加载资源…</p>
  <p v-else-if="error" role="alert" class="detail-feedback form-error">{{error}}</p>
  <p v-else-if="!resource" role="status" class="detail-feedback">资源已删除或不存在。</p>
  <div v-else class="links-drawer">
   <section class="resource-details">
    <div class="detail-meta"><AdminStatusBadge :state="resource.enabled === false ? 'disabled' : 'enabled'">{{resource.enabled === false ? '已停用' : '已启用'}}</AdminStatusBadge><span>{{resource.datetime || '时间未知'}}</span></div>
    <ResourceDescription v-if="resource.description" variant="admin" :text="resource.description" />
   </section>
   <div class="links-filters"><Input v-model.trim="query" placeholder="搜索链接" aria-label="搜索链接" /><div class="links-selects"><AdminSelect v-model="provider" aria-label="筛选网盘"><option value="">全部网盘</option><option v-for="type in providers" :key="type" :value="type">{{label(type)}}</option></AdminSelect><AdminSelect v-model="status" aria-label="筛选检测状态"><option value="">全部检测状态</option><option v-for="value in ['有效','失效','未检测','待确认','待复检']" :key="value">{{value}}</option></AdminSelect></div><p>共 {{links.length}} 条链接<span v-if="filtered.length!==links.length"> · 匹配 {{filtered.length}} 条</span></p></div>
   <div class="links-scroll"><ol v-if="visible.length" class="links-list"><li v-for="(link,i) in visible" :key="link.linkKey||`${page}-${i}`" :class="{'focused-link':link.linkKey===initialKey}"><AdminResourceLink :link="link" :checking="checking.has(link.linkKey||'')" details /><div class="link-actions"><Button v-if="link.checkSupported" variant="outline" size="sm" :disabled="!link.linkKey||checking.has(link.linkKey)" @click="check(link)"><LoaderCircle v-if="checking.has(link.linkKey||'')" :size="14" class="tw:animate-spin" /><RefreshCw v-else :size="14" />{{checking.has(link.linkKey||'')?'检测中…':'检测有效性'}}</Button><span v-else class="unsupported-check">暂不支持检测</span><p v-if="errors[link.linkKey||'']" role="alert">{{errors[link.linkKey||'']}}</p></div></li></ol><p v-else class="links-empty">没有匹配的链接</p></div>
   <AdminPagination :page="page" :total-pages="pages" :total="filtered.length" :page-size="pageSize" @change="page=$event" @update:page-size="pageSize=$event" />
  </div>
 </AdminDialog>
</template>
<style scoped>
@layer components {
.detail-feedback{padding:24px;font-size:13px}.resource-details{display:grid;gap:12px;padding:20px 24px;border-bottom:1px solid var(--border)}.detail-meta{display:flex;align-items:center;gap:12px;font-size:12px;color:var(--muted-foreground)}


.links-drawer{display:flex;flex-direction:column;height:100%;min-height:0}.links-filters{display:grid;gap:12px;padding:20px 24px;border-bottom:1px solid var(--border)}.links-selects{display:grid;grid-template-columns:1fr 1fr;gap:8px}.links-filters p{margin:0;color:var(--muted-foreground);font-size:12px}
.links-scroll{overflow:auto;flex:1;min-height:0}.links-list{list-style:none;padding:0;margin:0}.links-list li{padding:20px 24px;border-bottom:1px solid var(--border)}.link-actions{display:flex;align-items:center;gap:12px;margin-top:12px;flex-wrap:wrap}.link-actions p{margin:0;font-size:12px;color:var(--destructive)}.unsupported-check{font-size:12px;color:var(--muted-foreground)}.focused-link{background:var(--muted)}
.links-empty{padding:48px 24px;text-align:center;color:var(--muted-foreground);font-size:14px}
}
</style>
