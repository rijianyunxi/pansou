<script setup lang="ts">
import { ChevronLeft, ChevronRight } from "@lucide/vue";
import { ref, useId, watch } from "vue";
import { Button } from "./ui/button";
import AdminSelect from "./AdminSelect.vue";
const props = defineProps<{
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
}>();
const emit = defineEmits<{
  change: [page: number];
  "update:page-size": [pageSize: number];
}>();
const jumpPage = ref<string | number>(String(props.page));
const jumpError = ref("");
const inputId = useId();
const errorId = `${inputId}-error`;

watch(
  () => props.page,
  (value) => {
    jumpPage.value = String(value);
    jumpError.value = "";
  },
);

function submitJump() {
  const value = Number(String(jumpPage.value).trim());
  if (!Number.isInteger(value) || value < 1 || value > props.totalPages) {
    jumpError.value = `请输入 1-${props.totalPages} 之间的页码`;
    return;
  }

  jumpError.value = "";
  if (value !== props.page) emit("change", value);
}
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
      ><div class="admin-pagination-jump">
        <label :for="inputId">跳至</label>
        <input
          :id="inputId"
          v-model="jumpPage"
          class="admin-pagination-page-input"
          type="number"
          min="1"
          :max="totalPages"
          inputmode="numeric"
          aria-label="跳转页码"
          :aria-invalid="jumpError ? 'true' : undefined"
          :aria-describedby="jumpError ? errorId : undefined"
          @focus="jumpError = ''"
          @keydown.enter.prevent="submitJump"
        />
        <span>页</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          @click="submitJump"
          >跳转</Button
        >
        <span
          v-if="jumpError"
          :id="errorId"
          class="admin-pagination-jump-error"
          role="alert"
          >{{ jumpError }}</span
        >
      </div>
      <span class="admin-page-number">{{ page }} / {{ totalPages }}</span
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
