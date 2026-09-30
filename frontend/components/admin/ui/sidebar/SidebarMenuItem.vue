<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/admin";

const props = defineProps<{
  class?: HTMLAttributes["class"];
}>();
</script>

<template>
  <li
    data-slot="sidebar-menu-item"
    data-sidebar="menu-item"
    :class="cn('tw:group/menu-item tw:relative', props.class)"
  >
    <slot />
  </li>
</template>
