<template>
  <div
    v-if="text"
    :class="[
      'resource-description',
      `resource-description--${variant}`,
      { 'is-expanded': expanded },
    ]">
    <p ref="contentRef" class="resource-description-content">{{ text }}</p>
    <button
      v-if="isOverflowing || expanded"
      class="resource-description-toggle"
      type="button"
      :aria-expanded="expanded"
      :aria-label="expanded ? '收起描述' : '展开描述'"
      @click="expanded = !expanded">
      <span>{{ expanded ? '收起' : '展开' }}</span>
      <svg
        :class="{ 'is-up': expanded }"
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = withDefaults(defineProps<{
  text?: string | null;
  variant?: "result" | "admin";
}>(), {
  text: "",
  variant: "result",
});

const contentRef = ref<HTMLElement | null>(null);
const expanded = ref(false);
const isOverflowing = ref(false);
let resizeObserver: ResizeObserver | undefined;

function measureOverflow() {
  const content = contentRef.value;
  if (!content) return;

  if (!expanded.value) {
    isOverflowing.value = content.scrollHeight > content.clientHeight + 1;
  }
}

watch(() => props.text, () => {
  expanded.value = false;
  isOverflowing.value = false;
  nextTick(measureOverflow);
});
watch(expanded, () => nextTick(measureOverflow));

onMounted(() => {
  nextTick(measureOverflow);
  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(measureOverflow);
    if (contentRef.value) resizeObserver.observe(contentRef.value);
  }
});

onBeforeUnmount(() => resizeObserver?.disconnect());
</script>

<style scoped>
.resource-description {
  min-width: 0;
  margin-top: 6px;
}

.resource-description-content {
  display: -webkit-box;
  overflow: hidden;
  margin: 0;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.65;
  overflow-wrap: anywhere;
  word-break: break-word;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  max-height: calc(1.65em * 2);
  transition: max-height 180ms ease;
}

.resource-description.is-expanded .resource-description-content {
  display: block;
  max-height: none;
}

.resource-description-toggle {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-height: 28px;
  margin-top: 4px;
  padding: 2px 0;
  border: 0;
  background: transparent;
  color: var(--primary);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
}

.resource-description-toggle:hover {
  color: var(--primary-dark);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.resource-description-toggle:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 3px;
  border-radius: 3px;
}

.resource-description-toggle svg {
  transition: transform 180ms ease;
}

.resource-description-toggle svg.is-up {
  transform: rotate(180deg);
}

.resource-description--admin {
  max-width: 280px;
  margin-top: 3px;
}

.resource-description--admin .resource-description-content {
  color: #94a3b8;
  font-size: 11px;
  line-height: 1.45;
  max-height: calc(1.45em * 2);
}

.resource-description--admin .resource-description-toggle {
  min-height: 24px;
  margin-top: 1px;
  color: #2563eb;
  font-size: 10px;
}

.resource-description--admin .resource-description-toggle:hover {
  color: #1d4ed8;
}

@media (max-width: 560px) {
  .resource-description--result .resource-description-toggle {
    min-height: 32px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .resource-description-content,
  .resource-description-toggle svg {
    transition: none;
  }
}

</style>
