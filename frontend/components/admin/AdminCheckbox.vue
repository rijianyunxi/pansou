<script setup lang="ts">
import { computed } from "vue";
import { Checkbox } from "./ui/checkbox";
import { checkboxState, checkboxValue } from "@/lib/adminControls";

defineOptions({ inheritAttrs: false });
// Vue casts absent Boolean props to false; keep checked-only bindings controlled.
const props = withDefaults(
  defineProps<{
    modelValue?: boolean | unknown[];
    checked?: boolean;
    value?: unknown;
    indeterminate?: boolean;
  }>(),
  { modelValue: undefined, checked: undefined },
);
const emit = defineEmits<{
  "update:modelValue": [value: boolean | unknown[]];
  change: [event: Event];
}>();
const selected = computed(() =>
  checkboxState(
    props.modelValue,
    props.checked,
    props.value,
    props.indeterminate,
  ),
);
function update(value: boolean | "indeterminate") {
  const checked = value === true;
  emit(
    "update:modelValue",
    checkboxValue(props.modelValue, props.value, checked),
  );
  const event = new Event("change");
  Object.defineProperty(event, "target", {
    value: { checked, value: props.value },
  });
  emit("change", event);
}
</script>
<template>
  <Checkbox
    v-bind="$attrs"
    :model-value="selected"
    @update:model-value="update"
  />
</template>
