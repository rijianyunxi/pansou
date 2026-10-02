<script setup lang="ts">
import { Card } from './ui/card';
defineProps<{ label: string }>();
</script>

<template>
  <Card class="link-task-panel tw:py-0 tw:gap-0">
    <p class="scroll-hint">左右滑动查看完整表格</p>
    <div class="link-task-scroll" role="region" :aria-label="label" tabindex="0">
      <table class="link-task-table" :aria-label="label"><slot /></table>
    </div>
    <slot name="footer" />
  </Card>
</template>

<style scoped>
@layer components {
.link-task-panel { min-width:0; overflow:hidden; gap:0; padding:0; }
.link-task-scroll { overflow-x:auto; }
.link-task-scroll:focus-visible { outline:2px solid var(--ring); outline-offset:-2px; }
.link-task-table { width:100%; min-width:960px; border-collapse:collapse; text-align:left; font-size:13px; line-height:1.6; }
.link-task-table :deep(th),.link-task-table :deep(td) { padding:12px 14px; border-bottom:1px solid var(--border); vertical-align:middle; }
.link-task-table :deep(th) { font-weight:500; color:var(--muted-foreground); white-space:nowrap; background:var(--muted); }
.link-task-table :deep(tbody tr:last-child td) { border-bottom:0; }
.link-task-table :deep(tbody tr:hover) { background:var(--muted); }
.link-task-table :deep(strong) { font-weight:600; }
.link-task-table :deep(small) { display:block; color:var(--muted-foreground); font-size:12px; line-height:1.8; }
.link-task-table :deep(.object-cell) { max-width:250px; min-width:180px; }
.link-task-table :deep(.object-cell strong),.link-task-table :deep(.object-cell small),.link-task-table :deep(.result-cell small) { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.link-task-table :deep(.result-cell) { max-width:270px; min-width:180px; }
.link-task-table :deep(.time-cell) { white-space:nowrap; }
.link-task-table :deep(.type-cell),.link-task-table :deep(.count-cell) { white-space:nowrap; }
.link-task-table :deep(.action-cell) { width:64px; text-align:right; }
.link-task-table :deep(.action-cell button) { min-height:44px; min-width:44px; }
.scroll-hint { display:none; margin:0; padding:10px 14px; color:var(--muted-foreground); font-size:12px; }
@media(max-width:600px) { .scroll-hint { display:block; } }
}
</style>
