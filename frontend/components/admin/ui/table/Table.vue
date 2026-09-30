<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, type HTMLAttributes } from "vue";
import { cn } from "@/lib/admin";
const props = defineProps<{ class?: HTMLAttributes["class"] }>();
const viewport = ref<HTMLDivElement>();
const table = ref<HTMLTableElement>();
const scrollable = ref(false);
let observer: ResizeObserver | undefined;
function measure() {
  scrollable.value =
    !!viewport.value &&
    viewport.value.scrollWidth > viewport.value.clientWidth + 1;
}
onMounted(() => {
  measure();
  observer = new ResizeObserver(measure);
  if (viewport.value) observer.observe(viewport.value);
  if (table.value) observer.observe(table.value);
});
onBeforeUnmount(() => observer?.disconnect());
</script>
<template>
  <div class="admin-table-wrapper">
    <p v-if="scrollable" class="admin-table-scroll-hint">
      左右滑动查看完整表格；聚焦表格后也可使用方向键。
    </p>
    <div
      ref="viewport"
      data-slot="table-container"
      class="tw:relative tw:w-full tw:overflow-auto"
      :tabindex="scrollable ? 0 : undefined"
      :role="scrollable ? 'region' : undefined"
      :aria-label="scrollable ? '可横向滚动的数据表格' : undefined"
    >
      <table
        ref="table"
        data-slot="table"
        :class="cn('tw:w-full tw:caption-bottom tw:text-sm', props.class)"
      >
        <slot />
      </table>
    </div>
  </div>
</template>
