<template>
  <span class="tg-copy">
    <button
      type="button"
      class="tg-copy-button"
      :class="{ compact }"
      :disabled="!text || busy"
      @click="copy"
    >
      {{ busy ? "复制中…" : label }}
    </button>
    <span
      v-if="feedback"
      class="tg-copy-feedback"
      :class="feedback.ok ? 'ok' : 'bad'"
      role="status"
    >{{ feedback.message }}</span>
  </span>
</template>
<script setup lang="ts">
import { copyTextToClipboard } from "../../utils/telegramProbeView";

const props = withDefaults(
  defineProps<{ text: string; label?: string; compact?: boolean }>(),
  { label: "复制", compact: false },
);
const busy = ref(false);
const feedback = ref<{ ok: boolean; message: string } | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;

async function copy() {
  if (busy.value || !props.text) return;
  busy.value = true;
  try {
    const result = await copyTextToClipboard(props.text);
    feedback.value = { ok: result.ok, message: result.message };
  } finally {
    busy.value = false;
  }
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => (feedback.value = null), 3600);
}

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
});
</script>
<style scoped>
.tg-copy {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}
.tg-copy-button {
  min-height: 30px;
  padding: 4px 10px;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  background: #fff;
  color: #334155;
  font-size: 11px;
  line-height: 1.4;
  cursor: pointer;
  white-space: nowrap;
}
.tg-copy-button.compact {
  min-height: 26px;
  padding: 2px 8px;
  font-size: 10px;
}
.tg-copy-button:hover:not(:disabled) {
  border-color: #2563eb;
  color: #1d4ed8;
  background: #eff6ff;
}
.tg-copy-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.tg-copy-feedback {
  font-size: 10px;
  color: #64748b;
  overflow-wrap: anywhere;
}
.tg-copy-feedback.ok {
  color: #166534;
}
.tg-copy-feedback.bad {
  color: #b91c1c;
}
</style>
