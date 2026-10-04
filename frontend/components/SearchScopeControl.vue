<template>
  <div class="scope-control" role="group" aria-label="搜索范围">
    <button
      type="button"
      :aria-pressed="!modelValue"
      :disabled="disabled"
      @click="$emit('update:modelValue', false)">
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></svg>
      本站搜索
    </button>
    <button
      type="button"
      :aria-pressed="modelValue"
      :aria-disabled="customDisabled || disabled ? 'true' : undefined"
      :title="customDisabled ? '未登录不可使用' : undefined"
      :disabled="disabled"
      :class="{ 'custom-disabled': customDisabled }"
      @click="onCustomClick">
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="m21 3-6 18-4-8-8-4 18-6Z"/><path d="m11 13 10-10"/></svg>
      自定义频道 <span class="count">{{ count }}</span>
    </button>
  </div>
</template>
<script setup lang="ts">
const props = defineProps<{
  modelValue: boolean;
  count: number;
  disabled?: boolean;
  customDisabled?: boolean;
}>();
const emit = defineEmits<{
  (event: "update:modelValue", value: boolean): void;
  (event: "custom-disabled"): void;
}>();
function onCustomClick() {
  if (props.disabled) return;
  if (props.customDisabled) {
    emit("custom-disabled");
    return;
  }
  emit("update:modelValue", true);
}
</script>
<style scoped>

.scope-control { display: inline-flex; align-items: center; gap: 22px; }
button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 44px; padding: 0 4px 10px; border: 0; border-bottom: 3px solid transparent; background: transparent; color: var(--text-secondary); font: inherit; font-size: 14px; font-weight: 550; cursor: pointer; white-space: nowrap; }
button[aria-pressed="true"] { color: var(--text-primary); border-bottom-color: var(--primary); font-weight: 750; }
button:hover:not(:disabled):not(.custom-disabled) { color: var(--primary); }
button:focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; }
button:disabled, button.custom-disabled { opacity: .5; cursor: not-allowed; }
svg { display: none; }
.count { padding: 1px 6px; border-radius: 6px; background: #f1f0ed; color: #77756f; font-size: 11px; }
@media(max-width:480px) { .scope-control { gap: 16px; } button { font-size: 13px; } }

</style>
