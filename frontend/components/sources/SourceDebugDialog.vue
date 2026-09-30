<template>
  <AdminDialog
    drawer
    wide
    :title="'测试 ' + source.name"
    description="输入关键词，检查统一结果或原始响应。"
    @close="emit('close')"
  >
    <div class="debug-dialog-shell">
      <div class="debug-dialog-content">
        <SourceDebugPanel
          :source="source"
          :report="report"
          :keyword="keyword"
          :running="running"
          :error="error"
          :show-request-details="true"
          embedded
          @send="$emit('send')"
          @update:keyword="$emit('update:keyword', $event)"
        />
      </div>
    </div>
  </AdminDialog>
</template>

<script setup lang="ts">
import AdminDialog from "@/components/admin/AdminDialog.vue";
import SourceDebugPanel from "./SourceDebugPanel.vue";
import type { SourceDefinition, SourceProbe } from "../../types/source";

defineProps<{
  source: SourceDefinition;
  report?: SourceProbe;
  keyword: string;
  running: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  close: [];
  send: [];
  "update:keyword": [value: string];
}>();
</script>

<style scoped>
@layer components {
  .debug-dialog-shell {
    display: flex;
    flex-direction: column;
    max-height: min(92dvh, 980px);
    overflow: hidden;
  }

  .debug-dialog-content {
    min-height: 0;
    overflow-y: auto;
    padding: 24px 30px 30px;
    scrollbar-gutter: stable;
  }

  @media (max-width: 700px) {
    .debug-dialog-shell {
      max-height: 100dvh;
    }

    .debug-dialog-content {
      padding: 18px;
    }
  }
}
</style>
