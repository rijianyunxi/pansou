<script setup lang="ts">
import { computed } from 'vue';
import { Clock3, CircleCheck, CircleX, CircleHelp, CircleOff, LoaderCircle, Pause, ShieldAlert } from '@lucide/vue';
const props = defineProps<{ state: string; label: string }>();
const icons = { queued: Clock3, running: LoaderCircle, completed: CircleCheck, failed: CircleX, blocked: ShieldAlert, ignored: CircleOff, paused: Pause, uncertain: CircleHelp };
const icon = computed(() => icons[props.state as keyof typeof icons] || CircleHelp);
</script>

<template><span class="task-state-badge" :data-state="state"><component :is="icon" :size="13" aria-hidden="true" />{{label}}</span></template>

<style scoped>
@layer components {
.task-state-badge { --state-fg:#52525b; --state-bg:#f4f4f5; display:inline-flex; align-items:center; gap:5px; padding:3px 8px; border-radius:6px; color:var(--state-fg); background:var(--state-bg); font-size:12px; font-weight:500; white-space:nowrap; line-height:1.6; }
.task-state-badge[data-state=queued] { --state-fg:#92400e; --state-bg:#fef3c7; }
.task-state-badge[data-state=running] { --state-fg:#1e40af; --state-bg:#dbeafe; }
.task-state-badge[data-state=completed] { --state-fg:#065f46; --state-bg:#d1fae5; }
.task-state-badge[data-state=failed] { --state-fg:#991b1b; --state-bg:#fee2e2; }
.task-state-badge[data-state=blocked],.task-state-badge[data-state=uncertain] { --state-fg:#9a3412; --state-bg:#ffedd5; }
:global(.dark .task-state-badge) { --state-fg:#d4d4d8; --state-bg:#27272a; }
:global(.dark .task-state-badge[data-state=queued]) { --state-fg:#fde68a; --state-bg:#451a03; }
:global(.dark .task-state-badge[data-state=running]) { --state-fg:#93c5fd; --state-bg:#172554; }
:global(.dark .task-state-badge[data-state=completed]) { --state-fg:#6ee7b7; --state-bg:#022c22; }
:global(.dark .task-state-badge[data-state=failed]) { --state-fg:#fca5a5; --state-bg:#450a0a; }
:global(.dark .task-state-badge[data-state=blocked]),:global(.dark .task-state-badge[data-state=uncertain]) { --state-fg:#fdba74; --state-bg:#431407; }
}
</style>
