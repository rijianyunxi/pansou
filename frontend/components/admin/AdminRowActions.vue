<script setup lang="ts">
import { h, useSlots, type VNode } from "vue";
import { MoreHorizontal } from "@lucide/vue";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
const props = withDefaults(defineProps<{ label?: string }>(), {
  label: "更多操作",
});
const slots = useSlots();
function flatten(nodes: VNode[]): VNode[] {
  return nodes.flatMap((node) =>
    typeof node.type === "symbol" && Array.isArray(node.children)
      ? flatten(node.children as VNode[])
      : typeof node.type === "symbol"
        ? []
        : [node],
  );
}
const Actions = () =>
  flatten(slots.default?.() || []).map((node, index) =>
    h(
      DropdownMenuItem,
      {
        key: index,
        asChild: true,
        disabled: !!node.props?.disabled,
        class: "admin-row-action-item",
      },
      { default: () => node },
    ),
  );
</script>
<template>
  <DropdownMenu
    ><DropdownMenuTrigger as-child
      ><Button
        variant="ghost"
        size="icon-sm"
        type="button"
        :aria-label="label"
        :title="label"
        ><MoreHorizontal :size="16" /></Button></DropdownMenuTrigger
    ><DropdownMenuContent align="end" class="tw:min-w-40"
      ><Actions /></DropdownMenuContent
  ></DropdownMenu>
</template>
