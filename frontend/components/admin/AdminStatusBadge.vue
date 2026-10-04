<script setup lang="ts">
import { computed } from 'vue';
import { Badge } from './ui/badge';

type StatusTone = 'success' | 'info' | 'warning' | 'danger' | 'muted';
const props = defineProps<{ state: string; tone?: StatusTone }>();
const tones: Record<string, StatusTone> = {
  enabled: 'success', active: 'success', approved: 'success', valid: 'success',
  completed: 'success', success: 'success', idle: 'success', closed: 'success',
  running: 'info', checking: 'info', started: 'info',
  queued: 'warning', pending: 'warning', waiting: 'warning', backoff: 'warning',
  'half-open': 'warning', exhausted: 'warning', uncertain: 'warning',
  failed: 'danger', error: 'danger', invalid: 'danger', open: 'danger',
  blocked: 'danger', unavailable: 'danger',
};
const tone = computed(() => props.tone || tones[props.state] || 'muted');
</script>

<template>
  <Badge variant="outline" class="admin-status-badge tw:rounded-md tw:px-2 tw:py-0.5 tw:gap-1.5 tw:text-xs tw:font-medium tw:text-[color:var(--status-fg)] tw:bg-[var(--status-bg)] tw:border-[var(--status-border)]" :data-state="state" :data-tone="tone">
    <slot name="icon"><span class="status-indicator" aria-hidden="true" /></slot>
    <slot />
  </Badge>
</template>

<style scoped>
@layer components {
  .admin-status-badge {
    --status-fg: #52525b;
    --status-bg: #f4f4f5;
    --status-border: #e4e4e7;
    color: var(--status-fg);
    background: var(--status-bg);
    border-color: var(--status-border);
    line-height: 1.5;
    vertical-align: middle;
  }
  .admin-status-badge[data-tone="success"] { --status-fg: #047857; --status-bg: #ecfdf5; --status-border: #a7f3d0; }
  .admin-status-badge[data-tone="info"] { --status-fg: #1d4ed8; --status-bg: #eff6ff; --status-border: #bfdbfe; }
  .admin-status-badge[data-tone="warning"] { --status-fg: #b45309; --status-bg: #fffbeb; --status-border: #fde68a; }
  .admin-status-badge[data-tone="danger"] { --status-fg: #b91c1c; --status-bg: #fef2f2; --status-border: #fecaca; }
  .status-indicator { width: 5px; height: 5px; flex-shrink: 0; border-radius: 50%; background: currentColor; }
  :global(.dark .admin-status-badge) { --status-fg: #d4d4d8; --status-bg: #27272a; --status-border: #3f3f46; }
  :global(.dark .admin-status-badge[data-tone="success"]) { --status-fg: #6ee7b7; --status-bg: #022c22; --status-border: #065f46; }
  :global(.dark .admin-status-badge[data-tone="info"]) { --status-fg: #93c5fd; --status-bg: #172554; --status-border: #1e40af; }
  :global(.dark .admin-status-badge[data-tone="warning"]) { --status-fg: #fde68a; --status-bg: #451a03; --status-border: #92400e; }
  :global(.dark .admin-status-badge[data-tone="danger"]) { --status-fg: #fca5a5; --status-bg: #450a0a; --status-border: #991b1b; }
}
</style>
