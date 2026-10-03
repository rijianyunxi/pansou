<script setup lang="ts">
import {computed,ref,watch} from 'vue';
import AdminDialog from './AdminDialog.vue';
import AdminSelect from './AdminSelect.vue';
import AdminPagination from './AdminPagination.vue';
import AdminResourceLink from './AdminResourceLink.vue';
import {Input} from './ui/input';
import {Button} from './ui/button';
import {RefreshCw,LoaderCircle} from '@lucide/vue';
import {CLOUD_TYPE_SHORT_LABELS} from '@/shared/cloudTypes';
import {linkObservation,type AdminResourceLinkData} from '@/lib/adminResourceLinks';
const props=defineProps<{resource:{name:string;links:AdminResourceLinkData[]};initialKey?:string;checking:Set<string>;errors:Record<string,string>}>();
defineEmits<{close:[];check:[link:AdminResourceLinkData]}>();
const provider=ref(''),status=ref(''),query=ref(''),page=ref(1),pageSize=ref(20);
const providers=computed(()=>[...new Set(props.resource.links.map(link=>link.type))]);
const filtered=computed(()=>props.resource.links.filter(link=>(!provider.value||link.type===provider.value)&&(!status.value||linkObservation(link).label===status.value)&&(!query.value||link.url.toLowerCase().includes(query.value.toLowerCase()))));
const pages=computed(()=>Math.max(1,Math.ceil(filtered.value.length/pageSize.value)));
const visible=computed(()=>filtered.value.slice((page.value-1)*pageSize.value,page.value*pageSize.value));
watch([provider,status,query,pageSize],()=>page.value=1);
watch(()=>props.initialKey,key=>{const index=props.resource.links.findIndex(link=>link.linkKey===key);page.value=Math.max(1,Math.floor(index/pageSize.value)+1);},{immediate:true});
watch(pages,total=>{page.value=Math.min(page.value,total);});
function label(type:string){return (CLOUD_TYPE_SHORT_LABELS as Record<string,string>)[type]||type;}
</script>
<template>
 <AdminDialog title="网盘链接" :description="resource.name" drawer @close="$emit('close')">
  <div class="links-drawer">
   <div class="links-filters"><Input v-model.trim="query" placeholder="搜索链接" aria-label="搜索链接" /><div class="links-selects"><AdminSelect v-model="provider" aria-label="筛选网盘"><option value="">全部网盘</option><option v-for="type in providers" :key="type" :value="type">{{label(type)}}</option></AdminSelect><AdminSelect v-model="status" aria-label="筛选检测状态"><option value="">全部检测状态</option><option v-for="value in ['有效','失效','未检测','待确认','待复检']" :key="value">{{value}}</option></AdminSelect></div><p>共 {{resource.links.length}} 条链接<span v-if="filtered.length!==resource.links.length"> · 匹配 {{filtered.length}} 条</span></p></div>
   <div class="links-scroll"><ol v-if="visible.length" class="links-list"><li v-for="(link,i) in visible" :key="link.linkKey||`${page}-${i}`" :class="{'focused-link':link.linkKey===initialKey}"><AdminResourceLink :link="link" :checking="checking.has(link.linkKey||'')" details /><div class="link-actions"><Button v-if="link.checkSupported" variant="outline" size="sm" :disabled="!link.linkKey||checking.has(link.linkKey)" @click="$emit('check',link)"><LoaderCircle v-if="checking.has(link.linkKey||'')" :size="14" class="tw:animate-spin" /><RefreshCw v-else :size="14" />{{checking.has(link.linkKey||'')?'检测中…':'检测有效性'}}</Button><span v-else class="unsupported-check">暂不支持检测</span><p v-if="errors[link.linkKey||'']" role="alert">{{errors[link.linkKey||'']}}</p></div></li></ol><p v-else class="links-empty">没有匹配的链接</p></div>
   <AdminPagination :page="page" :total-pages="pages" :total="filtered.length" :page-size="pageSize" @change="page=$event" @update:page-size="pageSize=$event" />
  </div>
 </AdminDialog>
</template>
<style scoped>
@layer components {

.links-drawer{display:flex;flex-direction:column;height:100%;min-height:0}.links-filters{display:grid;gap:12px;padding:20px 24px;border-bottom:1px solid var(--border)}.links-selects{display:grid;grid-template-columns:1fr 1fr;gap:8px}.links-filters p{margin:0;color:var(--muted-foreground);font-size:12px}
.links-scroll{overflow:auto;flex:1;min-height:0}.links-list{list-style:none;padding:0;margin:0}.links-list li{padding:20px 24px;border-bottom:1px solid var(--border)}.link-actions{display:flex;align-items:center;gap:12px;margin-top:12px;flex-wrap:wrap}.link-actions p{margin:0;font-size:12px;color:var(--destructive)}.unsupported-check{font-size:12px;color:var(--muted-foreground)}.focused-link{background:var(--muted)}
.links-empty{padding:48px 24px;text-align:center;color:var(--muted-foreground);font-size:14px}
}
</style>
