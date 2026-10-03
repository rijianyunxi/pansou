<script setup lang="ts">
import {computed} from 'vue';
import {Badge} from './ui/badge';
import {ArrowUpRight} from '@lucide/vue';
import {CLOUD_TYPE_SHORT_LABELS} from '@/shared/cloudTypes';
import {linkObservation,resourceLinkUrl,linkCheckTime,type AdminResourceLinkData} from '@/lib/adminResourceLinks';
const props=defineProps<{link:AdminResourceLinkData;details?:boolean;checking?:boolean}>();
const observation=computed(()=>linkObservation(props.link));
const label=computed(()=>(CLOUD_TYPE_SHORT_LABELS as Record<string,string>)[props.link.type]||props.link.type);
</script>
<template>
 <div class="resource-link-row" :class="{detailed:details}">
  <div class="link-main">
   <Badge variant="secondary" class="provider-badge tw:rounded-md tw:font-normal">{{label}}</Badge>
   <a :href="resourceLinkUrl(link.url)" :title="link.url" target="_blank" rel="noopener noreferrer nofollow" class="link-address">{{link.url}}</a>
   <ArrowUpRight v-if="details" :size="14" aria-hidden="true" class="tw:shrink-0 tw:text-muted-foreground" />
   <Badge variant="outline" class="link-observation resource-status tw:rounded-md tw:font-normal tw:text-xs" :data-tone="checking?'checking':observation.tone" :title="link.checkedAt?`最近检测：${linkCheckTime(link.checkedAt)}`:observation.label">{{checking?'检测中':observation.label}}</Badge>
  </div>
  <div v-if="details" class="link-details"><span v-if="link.password">提取码 <code>{{link.password}}</code></span><span v-if="link.createdAt">入库于 {{linkCheckTime(link.createdAt)}}</span><span>{{link.checkedAt?'检测于 '+linkCheckTime(link.checkedAt):link.lastAttemptAt?'尝试于 '+linkCheckTime(link.lastAttemptAt):'尚未检测'}}</span><span v-if="link.checkMessage">{{link.checkMessage}}</span></div>
 </div>
</template>
<style scoped>
@layer components {

.resource-link-row{min-width:0;max-width:100%;overflow:hidden}
.link-main{display:flex;align-items:center;gap:8px;min-width:0}.provider-badge{border-radius:5px;font-size:12px;font-weight:400}
.link-address{color:var(--foreground);min-width:0;flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:12px;text-decoration:none}.link-address:hover{text-decoration:underline}.link-address:focus-visible{outline:2px solid var(--ring);outline-offset:3px;border-radius:3px}
.link-observation{border-radius:5px;font-size:11px;font-weight:400;padding:2px 6px}
.link-details{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:10px;color:var(--muted-foreground);font-size:12px}.link-details code{color:var(--foreground);background:var(--muted);padding:2px 5px;border-radius:4px}
.detailed .link-address{white-space:normal;overflow-wrap:anywhere;line-height:1.6}.detailed .link-main{align-items:flex-start}
}
</style>
