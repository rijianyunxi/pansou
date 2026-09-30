<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/admin";
import { useSidebar } from "./utils";

const props = defineProps<{
  class?: HTMLAttributes["class"];
}>();

const { toggleSidebar } = useSidebar();
</script>

<template>
  <button
    data-sidebar="rail"
    data-slot="sidebar-rail"
    aria-label="Toggle Sidebar"
    :tabindex="-1"
    title="Toggle Sidebar"
    :class="
      cn(
        'tw:hover:after:bg-sidebar-border tw:absolute tw:inset-y-0 tw:z-20 tw:hidden tw:w-4 tw:-translate-x-1/2 tw:transition-all tw:ease-linear tw:group-data-[side=left]:-right-4 tw:group-data-[side=right]:left-0 tw:after:absolute tw:after:inset-y-0 tw:after:left-1/2 tw:after:w-0.5 tw:sm:flex',
        'tw:in-data-[side=left]:cursor-w-resize tw:in-data-[side=right]:cursor-e-resize',
        'tw:[[data-side=left][data-state=collapsed]_&]:cursor-e-resize tw:[[data-side=right][data-state=collapsed]_&]:cursor-w-resize',
        'tw:hover:group-data-[collapsible=offcanvas]:bg-sidebar tw:group-data-[collapsible=offcanvas]:translate-x-0 tw:group-data-[collapsible=offcanvas]:after:left-full',
        'tw:[[data-side=left][data-collapsible=offcanvas]_&]:-right-2',
        'tw:[[data-side=right][data-collapsible=offcanvas]_&]:-left-2',
        props.class,
      )
    "
    @click="toggleSidebar"
  >
    <slot />
  </button>
</template>
