<template>
  <div class="drawer-backdrop" @click.self="$emit('close')">
    <aside class="side-drawer debug-drawer" role="dialog" aria-modal="true" aria-labelledby="upstream-debug-title">
      <header class="drawer-header">
        <div class="drawer-title-group">
          <span class="source-avatar large" :style="{ '--source-color': source.color }">{{ source.initials }}</span>
          <div><h2 id="upstream-debug-title">测试 {{ source.name }}</h2></div>
        </div>
        <button class="icon-button" type="button" aria-label="关闭测试窗口" @click="$emit('close')"><ConsoleIcon name="close" /></button>
      </header>
      <div class="drawer-body debug-drawer-body">
        <UpstreamDebugPanel
          :source="source"
          :report="report"
          :keyword="keyword"
          :running="running"
          :error="error"
          @send="$emit('send')"
          @update:keyword="$emit('update:keyword', $event)"
        />
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
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
</script>
