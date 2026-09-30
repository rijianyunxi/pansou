<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/admin";

const props = defineProps<{
  class?: HTMLAttributes["class"];
}>();
</script>

<template>
  <div
    data-slot="sidebar-header"
    data-sidebar="header"
    :class="cn('tw:flex tw:flex-col tw:gap-2 tw:p-2', props.class)"
  >
    <slot />
  </div>
</template>
