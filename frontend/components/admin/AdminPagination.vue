<script setup lang="ts">
import { ChevronLeft, ChevronRight } from "@lucide/vue";
import { Button } from "./ui/button";
import AdminSelect from "./AdminSelect.vue";
defineProps<{
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
}>();
const emit = defineEmits<{
  change: [page: number];
  "update:page-size": [pageSize: number];
}>();
</script>
<template>
  <div class="admin-pagination">
    <span>共 {{ total }} 条记录</span>
    <div class="admin-pagination-controls">
      <span>每页</span
      ><AdminSelect
        :model-value="pageSize"
        aria-label="每页条数"
        @update:model-value="(value) => emit('update:page-size', Number(value))"
        ><option :value="10">10 条</option>
        <option :value="20">20 条</option>
        <option :value="50">50 条</option></AdminSelect
      ><span class="admin-page-number">{{ page }} / {{ totalPages }}</span
      ><Button
        type="button"
        variant="outline"
        size="icon-sm"
        :disabled="page <= 1"
        aria-label="上一页"
        @click="emit('change', page - 1)"
        ><ChevronLeft :size="15" /></Button
      ><Button
        type="button"
        variant="outline"
        size="icon-sm"
        :disabled="page >= totalPages"
        aria-label="下一页"
        @click="emit('change', page + 1)"
        ><ChevronRight :size="15"
      /></Button>
    </div>
  </div>
</template>
