<script setup lang="ts">
import { computed } from 'vue';
import { Clock3, CircleCheck, CircleX, CircleHelp, CircleOff, LoaderCircle, Pause, ShieldAlert } from '@lucide/vue';
import AdminStatusBadge from './AdminStatusBadge.vue';
const props = defineProps<{ state: string; label: string }>();
const icons = { queued: Clock3, running: LoaderCircle, completed: CircleCheck, failed: CircleX, blocked: ShieldAlert, ignored: CircleOff, paused: Pause, uncertain: CircleHelp };
const icon = computed(() => icons[props.state as keyof typeof icons] || CircleHelp);
</script>

<template>
  <AdminStatusBadge class="task-state-badge" :state="state" :tone="state === 'blocked' ? 'warning' : undefined">
    <template #icon><component :is="icon" :size="13" aria-hidden="true" /></template>
    {{ label }}
  </AdminStatusBadge>
</template>
