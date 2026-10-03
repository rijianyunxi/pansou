<script setup lang="ts">
import {computed} from 'vue';
import {RefreshCw,LoaderCircle} from '@lucide/vue';
import {CLOUD_TYPE_SHORT_LABELS} from '@/shared/cloudTypes';
import {linkObservation,type AdminResourceLinkData} from '@/lib/adminResourceLinks';
const props=defineProps<{link:AdminResourceLinkData;checking?:boolean;error?:string}>();
defineEmits<{open:[];check:[]}>();
const label=computed(()=>(CLOUD_TYPE_SHORT_LABELS as Record<string,string>)[props.link.type]||props.link.type);
const status=computed(()=>linkObservation(props.link));
</script>
<template>
 <span class="tag-wrapper"><span class="link-tag resource-status" :data-tone="checking?'checking':status.tone">
  <button type="button" class="tag-label" :title="link.url" :aria-label="`查看${label}链接：${link.url}`" @click="$emit('open')"><span>{{label}}</span><span class="tag-state">{{checking?'检测中':status.label}}</span></button>
  <button v-if="link.checkSupported" type="button" class="tag-check" :disabled="checking||!link.linkKey" :aria-label="`检测${label}链接：${link.url}`" :title="checking?'检测中':'检测此链接'" @click="$emit('check')"><LoaderCircle v-if="checking" :size="13" class="tw:animate-spin" /><RefreshCw v-else :size="13" /></button>
 </span><small v-if="error" role="alert" class="tag-error">{{error}}</small></span>
</template>
<style scoped>
@layer components {
.tag-wrapper{display:inline-flex;flex-direction:column;gap:4px;max-width:100%}.tag-error{font-size:12px;color:var(--destructive);overflow-wrap:anywhere;max-width:220px}
.link-tag{display:inline-flex;align-items:center;max-width:100%;border:1px solid var(--border);border-radius:6px;background:var(--background);font-size:12px;line-height:1.4;color:var(--foreground);overflow:hidden}
.link-tag button{appearance:none;border:0;border-radius:0;background:transparent;color:inherit;cursor:pointer;font:inherit;min-height:30px}
.tag-label{display:flex;gap:8px;align-items:center;padding:5px 9px;min-width:0}.tag-state{font-size:11px;color:inherit;white-space:nowrap}
.link-tag .tag-check{display:flex;align-items:center;justify-content:center;width:30px;padding:0;border-left:1px solid var(--resource-status-border);flex:none;color:inherit}.link-tag button:hover{background:color-mix(in srgb,currentColor 8%,transparent)}.link-tag button:focus-visible{outline:2px solid var(--ring);outline-offset:-2px}.link-tag button:disabled{cursor:wait;opacity:.6}
}
</style>
