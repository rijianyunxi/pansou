<script setup lang="ts">
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
defineProps<{ label: string }>();
</script>
<template>
  <Tooltip :delay-duration="200">
    <TooltipTrigger as-child :aria-label="label"><slot /></TooltipTrigger>
    <TooltipContent>{{ label }}</TooltipContent>
  </Tooltip>
</template>
