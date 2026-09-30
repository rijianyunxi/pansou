<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { apiFetch, apiErrorMessage } from "@/src/appRuntime";
import {
  sortedNodes,
  type NodeWeight,
  type OutboundPolicy,
  type ProxyNode,
} from "@/types/outbound";
import AdminCheckbox from "./AdminCheckbox.vue";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
const props = defineProps<{
  modelValue: OutboundPolicy;
  disabled?: boolean;
  post?: boolean;
}>();
const emit = defineEmits<{ "update:modelValue": [policy: OutboundPolicy] }>();
const nodes = ref<ProxyNode[]>([]),
  defaults = ref<NodeWeight[]>([]),
  loading = ref(true),
  error = ref("");
const members = computed(() =>
  props.modelValue.inherit ? defaults.value : props.modelValue.nodes,
);
const available = computed(() => [
  ...nodes.value,
  ...members.value
    .filter((m) => !nodes.value.some((n) => n.id === m.nodeId))
    .map((m) => ({
      id: m.nodeId,
      name: m.nodeId,
      kind: "proxy" as const,
      enabled: false,
      baseUrl: "",
      dailyLimit: 0,
      quotaUsed: 0,
      circuitState: "unknown",
      lastStatus: null,
      lastError: null,
      referenceCount: 0,
    })),
]);
const priority = computed(() =>
  sortedNodes(members.value)
    .map(
      (m) =>
        (nodes.value.find((n) => n.id === m.nodeId)?.name || m.nodeId) +
        "（" +
        m.weight +
        "）",
    )
    .join(" → "),
);
const noEnabledNodes = computed(
  () =>
    !loading.value &&
    !error.value &&
    members.value.length > 0 &&
    !members.value.some((m) =>
      nodes.value.some((n) => n.id === m.nodeId && n.enabled),
    ),
);
function selected(id: string) {
  return members.value.find((n) => n.nodeId === id);
}
function update(next: NodeWeight[]) {
  emit("update:modelValue", {
    nodes: next,
    version: props.modelValue.version,
    inherit: false,
  });
}
function toggle(id: string, on: boolean) {
  update(
    on
      ? [...members.value, { nodeId: id, weight: 10 }]
      : members.value.filter((n) => n.nodeId !== id),
  );
}
function weight(id: string, value: unknown) {
  update(
    members.value.map((n) =>
      n.nodeId === id ? { ...n, weight: Number(value) } : n,
    ),
  );
}
async function load() {
  loading.value = true;
  error.value = "";
  try {
    nodes.value = (
      await apiFetch<{ data: { nodes: ProxyNode[] } }>("/api/admin/proxies", {
        silentError: true,
      })
    ).data.nodes;
    if (props.modelValue.inherit) {
      defaults.value =
        (
          await apiFetch<{ data: { outbound: OutboundPolicy | null } }>(
            "/api/admin/crawl/default-outbound",
            { silentError: true },
          )
        ).data.outbound?.nodes || [];
    }
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>
<template>
  <section class="outbound-editor" aria-label="节点选择">
    <p class="outbound-help">
      勾选节点并填写权重，权重越大越优先；相同权重按节点 ID
      倒序。直连也按权重参与，不勾选就不会直连。
    </p>
    <p v-if="modelValue.inherit" class="outbound-help">
      当前使用 TG 默认节点。调整勾选或权重后，将独立保存当前频道的节点。
    </p>
    <p v-if="loading" role="status">正在加载节点…</p>
    <div v-else-if="error" class="outbound-error" role="alert">
      {{ error }}
      <Button
        type="button"
        variant="outline"
        size="sm"
        :disabled="disabled"
        @click="load"
        >重试</Button
      >
    </div>
    <template v-else>
      <div
        v-for="node in available"
        :key="node.id"
        class="outbound-node"
        :class="{ 'outbound-selected': !!selected(node.id) }"
      >
        <label class="outbound-choice"
          ><AdminCheckbox
            :checked="!!selected(node.id)"
            :disabled="disabled"
            :aria-label="'选择 ' + node.name"
            @change="
              (e) => toggle(node.id, (e.target as HTMLInputElement).checked)
            "
          /><span
            ><strong>{{ node.name }}</strong
            ><small :class="{ 'outbound-warning': !node.enabled }">{{
              node.kind === "direct"
                ? "直接访问目标 · 内置节点"
                : node.enabled
                  ? "代理节点"
                  : "节点已停用或不存在"
            }}</small></span
          ></label
        >
        <label class="outbound-weight"
          >权重<Input
            :model-value="selected(node.id)?.weight ?? 10"
            type="number"
            min="0"
            max="10000"
            step="1"
            :disabled="disabled || !selected(node.id)"
            :aria-label="node.name + ' 权重'"
            @update:model-value="(v) => weight(node.id, v)"
        /></label>
      </div>
      <p v-if="!members.length" class="outbound-warning" role="status">
        请选择至少一个节点（可以只选择直连）。
      </p>
      <p v-if="noEnabledNodes" class="outbound-warning" role="status">
        选中的节点均不可用，请启用节点或选择直连。
      </p>
      <p v-if="priority" class="outbound-help outbound-priority">
        尝试顺序：{{ priority }}
      </p>
      <p v-if="post" class="outbound-help">
        POST 请求只发送一次，避免重复提交；不可用节点会在发送前跳过。
      </p>
    </template>
  </section>
</template>
<style scoped>
@layer components {
  .outbound-editor {
    display: grid;
    gap: 12px;
    min-width: 0;
  }
  .outbound-help {
    font-size: 12px;
    line-height: 1.7;
    color: var(--muted-foreground);
    overflow-wrap: anywhere;
  }
  .outbound-node {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 88px;
    gap: 16px;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px;
  }
  .outbound-selected {
    background: var(--muted);
  }
  .outbound-choice {
    display: flex;
    gap: 10px;
    align-items: center;
    min-width: 0;
    cursor: pointer;
  }
  .outbound-choice span {
    display: grid;
    gap: 4px;
    min-width: 0;
  }
  .outbound-choice strong {
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  .outbound-choice small {
    font-size: 12px;
    color: var(--muted-foreground);
  }
  .outbound-weight {
    display: grid;
    gap: 5px;
    font-size: 12px;
    color: var(--muted-foreground);
  }
  .outbound-warning,
  .outbound-error {
    color: var(--destructive);
    font-size: 12px;
    line-height: 1.7;
  }
  .outbound-error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .outbound-priority {
    padding-top: 6px;
    border-top: 1px solid var(--border);
  }
  @media (max-width: 480px) {
    .outbound-node {
      grid-template-columns: minmax(0, 1fr) 74px;
      gap: 10px;
      padding: 10px;
    }
  }
}
</style>
