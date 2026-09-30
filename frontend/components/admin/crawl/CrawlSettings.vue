<script setup lang="ts">
import { onMounted, ref } from "vue";
import { apiFetch, apiErrorMessage } from "@/src/appRuntime";
import { directPolicy } from "@/types/outbound";
import type { OutboundPolicy } from "@/types/outbound";
import AdminDialog from "../AdminDialog.vue";
import OutboundPolicyEditor from "../OutboundPolicyEditor.vue";
import { useAdminConfirm } from "@/composables/admin/useAdminConfirm";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
const emit = defineEmits<{ close: []; saved: [] }>();
const { confirm } = useAdminConfirm();
const tab = ref("outbound"),
  policy = ref<OutboundPolicy>(directPolicy()),
  inheritors = ref(0),
  transform = ref(""),
  templateVersion = ref(0),
  loading = ref(true),
  busy = ref(false),
  loaded = ref(false),
  error = ref("");
let baselinePolicy = "",
  baselineTransform = "";
async function close() {
  if (busy.value) return;
  if (
    baselinePolicy &&
    (baselinePolicy !== JSON.stringify(policy.value) ||
      baselineTransform !== transform.value) &&
    !(await confirm("放弃尚未保存的采集默认设置？"))
  )
    return;
  emit("close");
}
onMounted(async () => {
  try {
    const [p, t] = await Promise.all([
      apiFetch<{
        data: { outbound: OutboundPolicy | null; inheritors: number };
      }>("/api/admin/crawl/default-outbound"),
      apiFetch<{ data: { transform: string; version: number } }>(
        "/api/settings/source-template",
      ),
    ]);
    policy.value = p.data.outbound || directPolicy();
    inheritors.value = p.data.inheritors;
    transform.value = t.data.transform;
    templateVersion.value = t.data.version;
    baselinePolicy = JSON.stringify(policy.value);
    baselineTransform = transform.value;
    loaded.value = true;
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    loading.value = false;
  }
});
async function save() {
  if (busy.value) return;
  if (
    tab.value === "outbound" &&
    !(await confirm(
      "更新 TG 默认出站策略？影响 " +
        inheritors.value +
        " 个继承频道，独立配置不受影响。",
    ))
  )
    return;
  busy.value = true;
  error.value = "";
  try {
    if (tab.value === "outbound") {
      const r = await apiFetch<{ data: { outbound: OutboundPolicy } }>(
        "/api/admin/crawl/default-outbound",
        { method: "PUT", body: policy.value },
      );
      policy.value = r.data.outbound;
      baselinePolicy = JSON.stringify(policy.value);
    } else {
      const savedTemplate = await apiFetch<{ data: { version: number } }>(
        "/api/settings/source-template",
        {
          method: "PUT",
          body: {
            transform: transform.value,
            version: templateVersion.value,
            urlTemplate: "https://t.me/s/{{channel}}",
            method: "GET",
            format: "html",
          },
        },
      );
      templateVersion.value = savedTemplate.data.version;
      baselineTransform = transform.value;
    }
    emit("saved");
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <AdminDialog
    title="TG 采集设置"
    description="仅影响继承默认配置的频道，不覆盖独立频道策略。"
    drawer
    :busy="busy"
    @close="close"
    ><form class="admin-dialog-form" @submit.prevent="save">
      <div class="admin-form-fields">
        <p v-if="loading" role="status">正在加载默认设置…</p>
        <template v-else
          ><Tabs v-model="tab"
            ><TabsList
              ><TabsTrigger value="outbound">默认出站策略</TabsTrigger
              ><TabsTrigger value="parser">默认解析模板</TabsTrigger></TabsList
            ></Tabs
          ><template v-if="tab === 'outbound'"
            ><p class="tw:text-sm tw:text-muted-foreground">
              当前 {{ inheritors }} 个频道继承此策略。
            </p>
            <OutboundPolicyEditor v-model="policy" :disabled="busy" /></template
          ><template v-else
            ><label
              >Rust transform DSL<Textarea
                v-model="transform"
                rows="18"
                spellcheck="false"
            /></label>
            <p class="tw:text-sm tw:text-muted-foreground">
              模板修改不会自动重写历史资源，需要明确重解析。
            </p></template
          ></template
        >
      </div>
      <footer class="modal-actions">
        <p v-if="error" role="alert" class="form-error">{{ error }}</p>
        <Button type="button" variant="outline" :disabled="busy" @click="close"
          >关闭</Button
        ><Button :disabled="busy || loading || !loaded">{{
          busy
            ? "保存中…"
            : tab === "outbound"
              ? "保存默认策略"
              : "保存解析模板"
        }}</Button>
      </footer>
    </form></AdminDialog
  >
</template>
