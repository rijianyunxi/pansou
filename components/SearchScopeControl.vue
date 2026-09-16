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
      :title="customDisabled ? '自定义频道仅对登录用户开放，请先登录或注册。' : undefined"
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
.scope-control { display: inline-flex; gap: 4px; padding: 4px; border-radius: 13px; background: var(--bg-secondary); border: 1px solid var(--border-light); }
button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 44px; padding: 0 14px; border: 1px solid transparent; border-radius: 9px; background: transparent; color: var(--text-secondary); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; transition: background .15s, color .15s; white-space: nowrap; }
button[aria-pressed="true"] { background: var(--bg-primary); color: var(--primary); border-color: var(--border-light); box-shadow: var(--shadow-sm); }
button:hover:not(:disabled):not(.custom-disabled) { color: var(--primary); }
button:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
button:disabled, button.custom-disabled { opacity: .55; cursor: not-allowed; }
button.custom-disabled[aria-pressed="true"] { background: var(--bg-secondary); color: var(--text-secondary); border-color: transparent; box-shadow: none; }
svg { width: 16px; height: 16px; flex-shrink: 0; }
.count { padding: 1px 6px; border-radius: 5px; background: var(--primary-soft); font-size: 11px; font-variant-numeric: tabular-nums; }
@media (max-width: 480px) { .scope-control { display: flex; } button { flex: 1; padding: 0 10px; } }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
</style>
