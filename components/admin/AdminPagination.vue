<template>
  <div class="pagination">
    <span class="pagination-total">共 {{ total }} 条</span>
    <div class="pagination-controls">
      <button class="pagination-button" type="button" :disabled="page <= 1" aria-label="上一页" @click="$emit('change', page - 1)">‹</button>
      <span class="pagination-current">第 {{ page }} / {{ totalPages }} 页</span>
      <button class="pagination-button" type="button" :disabled="page >= totalPages" aria-label="下一页" @click="$emit('change', page + 1)">›</button>
      <select class="pagination-size" :value="pageSize" aria-label="每页条数" @change="onPageSizeChange">
        <option :value="10">10 条/页</option>
        <option :value="20">20 条/页</option>
        <option :value="50">50 条/页</option>
      </select>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ page: number; totalPages: number; total: number; pageSize: number }>();
const emit = defineEmits<{ change: [page: number]; "update:page-size": [pageSize: number] }>();
function onPageSizeChange(event: Event) {
  emit("update:page-size", Number((event.target as HTMLSelectElement).value));
}
</script>

<style scoped>
.pagination { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 13px 16px; border-top: 1px solid #eef2f7; color: #8a96a3; font-size: 10px; }
.pagination-controls { display: flex; align-items: center; gap: 8px; }
.pagination-current { min-width: 80px; color: #64748b; text-align: center; }
.pagination-button { display: grid; place-items: center; width: 30px; height: 30px; padding: 0; border: 1px solid #dbe1ea; border-radius: 7px; color: #475569; background: #fff; font-size: 19px; line-height: 1; cursor: pointer; }
.pagination-button:hover:not(:disabled) { border-color: #93c5fd; color: #2563eb; background: #eff6ff; }
.pagination-button:disabled { cursor: not-allowed; opacity: .4; }
.pagination-size { min-height: 30px; padding: 0 7px; border: 1px solid #dbe1ea; border-radius: 7px; color: #64748b; background: #fff; font: inherit; font-size: 10px; }
@media (max-width: 820px) { .pagination { align-items: flex-start; flex-direction: column; }.pagination-controls { width: 100%; justify-content: flex-end; } }
</style>
