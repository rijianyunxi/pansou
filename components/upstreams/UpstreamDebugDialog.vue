<template>
  <dialog
    ref="dialog"
    class="source-dialog upstream-debug-dialog"
    aria-labelledby="upstream-debug-title"
    @close="$emit('close')"
    @click="onBackdrop"
  >
    <div class="debug-dialog-shell">
      <header class="debug-dialog-header">
        <div class="debug-dialog-title-wrap">
          <div class="editor-title-line">
            <span class="editor-kicker">SOURCE DEBUGGING</span>
            <span class="editor-mode-badge">在线调试</span>
          </div>
          <h2 id="upstream-debug-title">测试 {{ source.name }}</h2>
          <p>输入关键词发送测试，查看来源返回的统一结果或原始响应。</p>
        </div>
        <button class="icon-button" type="button" aria-label="关闭测试窗口" @click="dialog?.close()">
          <ConsoleIcon name="close" />
        </button>
      </header>

      <div class="debug-dialog-content">
        <UpstreamDebugPanel
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
  </dialog>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import ConsoleIcon from "./ConsoleIcon.vue";
import UpstreamDebugPanel from "./UpstreamDebugPanel.vue";
import type { UpstreamDefinition, UpstreamProbe } from "../../types/source";

defineProps<{
  source: UpstreamDefinition;
  report?: UpstreamProbe;
  keyword: string;
  running: boolean;
  error?: string;
}>();

defineEmits<{
  close: [];
  send: [];
  "update:keyword": [value: string];
}>();

const dialog = ref<HTMLDialogElement>();

function onBackdrop(event: MouseEvent) {
  if (event.target === dialog.value) dialog.value?.close();
}

onMounted(() => dialog.value?.showModal());
</script>

<style scoped>
.upstream-debug-dialog {
  width: min(920px, calc(100vw - 48px));
  max-width: none;
  max-height: min(92dvh, 980px);
  overflow: hidden;
}

.debug-dialog-shell {
  display: flex;
  flex-direction: column;
  max-height: min(92dvh, 980px);
  overflow: hidden;
}

.debug-dialog-header {
  position: relative;
  z-index: 1;
  display: flex;
  flex: 0 0 auto;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding: 25px 30px 22px;
  border-bottom: 1px solid #e7edf5;
  background:
    radial-gradient(circle at 88% 0%, rgba(219, 234, 254, 0.62), transparent 36%),
    linear-gradient(180deg, #ffffff 0%, #fbfdff 100%);
}

.debug-dialog-title-wrap {
  min-width: 0;
}

.debug-dialog-title-wrap h2 {
  margin: 7px 0 0;
  color: #1e293b;
  font-size: 22px;
  font-weight: 650;
}

.debug-dialog-title-wrap p {
  margin: 7px 0 0;
  color: #64748b;
  font-size: 12px;
  line-height: 1.6;
}

.debug-dialog-content {
  min-height: 0;
  overflow-y: auto;
  padding: 24px 30px 30px;
  scrollbar-gutter: stable;
}

@media (max-width: 700px) {
  .upstream-debug-dialog {
    width: 100vw;
    max-width: 100vw;
    max-height: 100dvh;
    margin: 0;
    border: 0;
    border-radius: 0;
  }

  .debug-dialog-shell {
    max-height: 100dvh;
  }

  .debug-dialog-header {
    padding: 20px 18px 18px;
  }

  .debug-dialog-content {
    padding: 18px;
  }
}
</style>
