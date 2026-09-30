<template>
  <SourceEditor
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
import SourceEditor from "./SourceEditor.vue";
import type { SourceDefinition } from "../../types/source";

defineProps<{
  source: SourceDefinition;
  running: boolean;
}>();

defineEmits<{
  close: [];
  edit: [];
  debug: [];
  delete: [];
}>();
</script>
