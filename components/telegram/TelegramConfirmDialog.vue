<template>
  <Teleport to="body">
    <dialog ref="dialog" class="tg-confirm-dialog" aria-labelledby="tg-confirm-title" @close="$emit('cancel')" @click="onBackdropClick">
      <form class="confirm-card" @submit.prevent="$emit('confirm')">
        <h2 id="tg-confirm-title">{{ title }}</h2>
        <p class="confirm-message">{{ message }}</p>
        <p v-if="detail" class="confirm-detail">{{ detail }}</p>
        <div class="confirm-actions">
          <button type="button" class="cancel-button" :disabled="busy" @click="dialog?.close()">取消</button>
          <button type="submit" class="danger-button" :disabled="busy">{{ busy ? "处理中…" : confirmLabel }}</button>
        </div>
      </form>
    </dialog>
  </Teleport>
</template>
<script setup lang="ts">
const props = withDefaults(defineProps<{ title: string; message: string; detail?: string; confirmLabel?: string; busy?: boolean }>(), {
  detail: "",
  confirmLabel: "确认删除",
  busy: false,
});
defineEmits<{ (event: "confirm"): void; (event: "cancel"): void }>();
const dialog = ref<HTMLDialogElement | null>(null);
let previousFocus: HTMLElement | null = null;
let previousOverflow = "";
function onBackdropClick(event: MouseEvent) {
  const element = dialog.value;
  if (!element || event.target !== element || props.busy) return;
  element.close();
}
onMounted(() => {
  previousFocus = document.activeElement as HTMLElement;
  previousOverflow = document.body.style.overflow;
  dialog.value?.showModal();
  document.body.style.overflow = "hidden";
});
onBeforeUnmount(() => {
  dialog.value?.close();
  document.body.style.overflow = previousOverflow;
  if (previousFocus?.isConnected) previousFocus.focus();
});
</script>
<style scoped>
.tg-confirm-dialog { padding: 0; border: 0; border-radius: 14px; background: transparent; max-width: min(440px, calc(100vw - 32px)); width: 100%; }
.tg-confirm-dialog::backdrop { background: #0f172a66; backdrop-filter: blur(2px); }
.confirm-card { background: white; border-radius: 14px; padding: 22px; display: grid; gap: 12px; box-shadow: 0 24px 60px #0f172a33; color: #1e293b; }
h2 { margin: 0; font-size: 17px; }
.confirm-message { margin: 0; font-size: 13px; line-height: 1.7; color: #334155; overflow-wrap: anywhere; }
.confirm-detail { margin: 0; font-size: 12px; line-height: 1.7; color: #64748b; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px 12px; overflow-wrap: anywhere; }
.confirm-actions { display: flex; justify-content: flex-end; gap: 10px; }
button { min-height: 40px; padding: 8px 16px; border-radius: 8px; border: 1px solid #cbd5e1; background: white; font: inherit; color: #334155; cursor: pointer; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.cancel-button:hover:not(:disabled) { background: #f1f5f9; }
.danger-button { background: #dc2626; border-color: #dc2626; color: white; font-weight: 600; }
.danger-button:hover:not(:disabled) { background: #b91c1c; }
button:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
@media (max-width: 480px) { .confirm-card { padding: 16px; } .confirm-actions { flex-direction: column-reverse; } .confirm-actions button { width: 100%; } }
</style>
