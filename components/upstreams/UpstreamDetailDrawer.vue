<template>
  <UpstreamEditor
    :source="source"
    :readonly="true"
    :running="running"
    @close="$emit('close')"
    @edit="$emit('edit')"
    @debug="$emit('debug')"
    @delete="$emit('delete')"
  />
</template>

<script setup lang="ts">
import UpstreamEditor from "./UpstreamEditor.vue";
import type { UpstreamDefinition } from "../../types/source";

defineProps<{
  source: UpstreamDefinition;
  running: boolean;
}>();

defineEmits<{
  close: [];
  edit: [];
  debug: [];
  delete: [];
}>();
</script>
