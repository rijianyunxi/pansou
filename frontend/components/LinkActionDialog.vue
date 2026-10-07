<template>
  <dialog ref="element" class="link-dialog" aria-labelledby="link-dialog-title" aria-describedby="link-dialog-description" @cancel.prevent="emit('close')" @click="backdrop">
    <div v-if="state" class="link-dialog-content">
      <button type="button" class="dialog-close" aria-label="关闭取链窗口" @click="emit('close')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
      <div :class="['dialog-symbol', state.status]" aria-hidden="true">
        <span v-if="state.status === 'loading'" class="dialog-orbit"></span>
        <svg v-if="state.status === 'loading'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 1 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(2 0) scale(.85)"/></svg>
        <svg v-else-if="state.status === 'error'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 7v6m0 4h.01"/><circle cx="12" cy="12" r="9"/></svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path class="dialog-check" d="m5 12 4 4L19 6"/></svg>
      </div>
      <h2 id="link-dialog-title">{{ title }}</h2>
      <p id="link-dialog-description" class="dialog-description" role="status" aria-live="polite">{{ description }}</p>
      <div class="dialog-resource"><span>{{ state.provider }}</span><p>{{ state.name }}</p></div>
      <div v-if="state.status === 'loading'" class="dialog-wait"><span class="wait-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>{{ elapsed >= 12 ? '正在耐心等待响应' : '稍等片刻就好' }}</span></div>
      <div class="dialog-actions">
        <button v-if="state.status === 'loading'" type="button" class="dialog-secondary" @click="emit('close')">稍后继续</button>
        <template v-else-if="state.status === 'error'"><button type="button" class="dialog-secondary" @click="emit('close')">关闭</button><button v-if="state.retryable !== false" type="button" class="dialog-primary" @click="emit('retry')">再试一次</button></template>
        <template v-else-if="state.status === 'ready'"><button type="button" class="dialog-secondary" @click="emit('copy')">复制链接</button><a class="dialog-primary" :href="state.url" target="_blank" rel="noopener noreferrer" @click="emit('open', $event)">打开资源 ↗</a></template>
        <button v-else type="button" class="dialog-primary" @click="emit('close')">完成</button>
      </div>
    </div>
  </dialog>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
export interface LinkDialogState { status: 'loading' | 'success' | 'ready' | 'error'; action: 'open' | 'copy'; name: string; provider: string; message?: string; url?: string; retryable?: boolean; startedAt: number; }
const props = defineProps<{ state: LinkDialogState | null; now: number }>();
const emit = defineEmits<{ close: []; retry: []; copy: []; open: [event: MouseEvent] }>();
const element = ref<HTMLDialogElement>();
const elapsed = computed(() => Math.floor((props.now - (props.state?.startedAt || props.now)) / 1000));
const title = computed(() => ({ loading: '正在获取链接', success: '链接已复制', ready: '链接已就绪', error: '暂时没能完成' }[props.state?.status || 'loading']));
const description = computed(() => props.state?.message || (props.state?.status === 'loading' ? elapsed.value >= 15 ? '这次需要多等一会儿，你也可以稍后继续。' : props.state.action === 'copy' ? '准备好后会自动复制到剪贴板。' : '准备好后，点击打开即可查看资源。' : props.state?.status === 'ready' ? '点击打开资源，继续查看。' : '去浏览器或网盘 App 粘贴打开。'));
watch(() => !!props.state, async open => { await nextTick(); if (open && !element.value?.open) element.value?.showModal(); else if (!open) element.value?.close(); }, { immediate: true });
function backdrop(event: MouseEvent) { if (event.target === element.value) { const r = element.value.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) emit('close'); } }
onBeforeUnmount(() => element.value?.close());
</script>
<style scoped>
.link-dialog { --dialog-accent: #c84916; width: min(368px,calc(100vw - 40px)); max-height: calc(100dvh - 40px); box-sizing: border-box; padding: 0; margin: auto; border: 1px solid var(--border-light,#eee6db); border-radius: 24px; background: var(--bg-primary,#fff); color: var(--text-primary,#24231f); box-shadow: 0 24px 90px #241d1833; overflow-y: auto; }
.link-dialog[open] { animation: dialog-in .2s ease-out; }
.link-dialog::backdrop { background: #231b1459; backdrop-filter: blur(3px); }
.link-dialog-content { position: relative; padding: 32px 28px 24px; text-align: center; }
.dialog-close { position: absolute; right: 8px; top: 8px; display: grid; place-items: center; width: 44px; height: 44px; padding: 12px; border: 0; border-radius: 50%; color: var(--text-secondary,#706c65); background: transparent; cursor: pointer; }
.dialog-close svg { width: 20px; height: 20px; }
.dialog-symbol { width: 72px; height: 72px; display: grid; place-items: center; position: relative; margin: 4px auto 22px; border-radius: 50%; background: color-mix(in srgb,var(--dialog-accent) 9%,var(--bg-primary,#fff)); color: var(--dialog-accent); }
.dialog-symbol svg { width: 32px; height: 32px; }
.dialog-symbol.error { color: #bc442d; background: #fff0ed; }
.dialog-orbit { position: absolute; inset: -2px; border: 2px solid transparent; border-top-color: var(--dialog-accent); border-right-color: color-mix(in srgb,var(--dialog-accent) 25%,transparent); border-radius: 50%; animation: dialog-spin 1.1s linear infinite; }
.dialog-check { stroke-dasharray: 30; animation: dialog-check .25s ease-out; }
h2 { margin: 0; font-size: 21px; line-height: 1.4; font-weight: 650; }
.dialog-description { margin: 10px 0 22px; min-height: 44px; color: var(--text-secondary,#706c65); font-size: 14px; line-height: 1.6; }
.dialog-resource { padding: 13px 15px; border-radius: 12px; background: var(--bg-secondary,#fff8f2); text-align: left; }
.dialog-resource span { color: var(--dialog-accent); font-size: 12px; font-weight: 600; }
.dialog-resource p { margin: 5px 0 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.dialog-wait { display: flex; align-items: center; justify-content: center; gap: 9px; min-height: 42px; color: var(--text-secondary,#706c65); font-size: 12px; }
.wait-dots { display: flex; gap: 4px; }.wait-dots i { width: 4px; height: 4px; border-radius: 50%; background: var(--dialog-accent); animation: dialog-pulse 1.2s ease-in-out infinite; }.wait-dots i:nth-child(2){animation-delay:.15s}.wait-dots i:nth-child(3){animation-delay:.3s}
.dialog-actions { display: flex; gap: 10px; margin-top: 22px; }.dialog-wait + .dialog-actions { margin-top: 0; }
.dialog-actions button,.dialog-actions a { display: flex; flex: 1; align-items: center; justify-content: center; min-height: 46px; padding: 9px 12px; box-sizing: border-box; border-radius: 11px; border: 1px solid var(--border-light,#ece7de); font: inherit; font-size: 14px; font-weight: 600; text-decoration: none; cursor: pointer; }
.dialog-actions .dialog-primary { color: #fff; background: #c84916; border-color: #c84916; }.dialog-secondary { color: var(--text-secondary,#706c65); background: var(--bg-primary,#fff); }
.dialog-actions a:hover,.dialog-actions button:hover { filter: brightness(.96); }button:focus-visible,a:focus-visible { outline: 3px solid #e77c44; outline-offset: 3px; }
@keyframes dialog-in { from { opacity:0; transform:translateY(8px) scale(.98); } to { opacity:1; transform:none; } }@keyframes dialog-spin { to { transform:rotate(360deg); } }@keyframes dialog-pulse { 50% { opacity:.3; } }@keyframes dialog-check { from { stroke-dashoffset:30; } to { stroke-dashoffset:0; } }
@media(prefers-reduced-motion:reduce) { .link-dialog[open],.dialog-orbit,.wait-dots i,.dialog-check { animation:none; } }
</style>
