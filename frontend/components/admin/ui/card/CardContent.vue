<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/admin";

const props = defineProps<{
  class?: HTMLAttributes["class"];
}>();
</script>

<template>
  <div data-slot="card-content" :class="cn('tw:px-6', props.class)">
    <slot />
  </div>
</template>
