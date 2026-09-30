<script setup lang="ts">
import { X } from "@lucide/vue";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "./ui/sheet";
import { Button } from "./ui/button";
withDefaults(
  defineProps<{
    title: string;
    description?: string;
    drawer?: boolean;
    wide?: boolean;
    busy?: boolean;
  }>(),
  { drawer: false, wide: false, busy: false },
);
const emit = defineEmits<{ close: [] }>();
</script>
<template>
  <component
    :is="drawer ? Sheet : Dialog"
    :open="true"
    @update:open="
      (value) => {
        if (!value && !busy) emit('close');
      }
    "
  >
    <component
      :is="drawer ? SheetContent : DialogContent"
      :show-close-button="false"
      :class="[
        'admin-dialog-content',
        { 'admin-drawer-content': drawer, 'admin-dialog-wide': wide },
      ]"
      @escape-key-down="
        (event: Event) => {
          if (busy) event.preventDefault();
        }
      "
      @interact-outside.prevent
    >
      <header class="admin-dialog-header">
        <div class="admin-dialog-heading">
          <component
            :is="drawer ? SheetTitle : DialogTitle"
            class="admin-dialog-title"
            >{{ title }}</component
          >
          <component
            :is="drawer ? SheetDescription : DialogDescription"
            :class="description ? 'admin-dialog-description' : 'tw:sr-only'"
            >{{ description || title }}</component
          >
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          :disabled="busy"
          aria-label="关闭窗口"
          @click="emit('close')"
          ><X :size="18"
        /></Button>
      </header>
      <div class="admin-dialog-body"><slot /></div>
    </component>
  </component>
</template>
