<script setup lang="ts">
import { computed, useSlots } from "vue";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import {
  EMPTY_SELECT_VALUE,
  selectOptions,
  selectValue,
} from "@/lib/adminControls";

defineOptions({ inheritAttrs: false });
const props = defineProps<{
  modelValue?: string | number;
  value?: string | number;
  disabled?: boolean;
  name?: string;
  required?: boolean;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: string | number];
  change: [event: Event];
}>();
const slots = useSlots();
const selected = computed(
  () => String(props.modelValue ?? props.value ?? "") || EMPTY_SELECT_VALUE,
);
function update(value: unknown) {
  const output = selectValue(value, props.modelValue ?? props.value);
  emit("update:modelValue", output);
  const event = new Event("change");
  Object.defineProperty(event, "target", { value: { value: String(output) } });
  emit("change", event);
}
</script>
<template>
  <Select
    :model-value="selected"
    :disabled="disabled"
    :name="name"
    :required="required"
    @update:model-value="update"
  >
    <SelectTrigger v-bind="$attrs" class="admin-select-trigger"
      ><SelectValue
    /></SelectTrigger>
    <SelectContent>
      <SelectItem
        v-for="option in selectOptions(slots.default?.() || [])"
        :key="option.value"
        :value="option.value"
        :disabled="option.disabled"
        >{{ option.text }}</SelectItem
      >
    </SelectContent>
  </Select>
</template>
