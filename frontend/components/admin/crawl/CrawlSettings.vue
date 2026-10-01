<script setup lang="ts">
import { onMounted, ref } from "vue";
import { apiFetch, apiErrorMessage } from "@/src/appRuntime";
import { directPolicy } from "@/types/outbound";
import { Input } from "../ui/input";
import type { CrawlSettingsValue } from "@/types/crawl";
import type { OutboundPolicy } from "@/types/outbound";
import AdminDialog from "../AdminDialog.vue";
import OutboundPolicyEditor from "../OutboundPolicyEditor.vue";
import { useAdminConfirm } from "@/composables/admin/useAdminConfirm";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
const emit = defineEmits<{ close: []; saved: [] }>();
const { confirm } = useAdminConfirm();
const schedule = ref<CrawlSettingsValue>({ concurrentChannels: 3, pageDelaySeconds: 3, dailyIntervalSeconds: 300, version: 1 });
let baselineSchedule = "";
const tab = ref("schedule"),
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
    (baselineSchedule !== JSON.stringify(schedule.value) || baselinePolicy !== JSON.stringify(policy.value) ||
      baselineTransform !== transform.value) &&
    !(await confirm("放弃尚未保存的采集默认设置？"))
  )
    return;
  emit("close");
}
onMounted(async () => {
  try {
    const [p, t, config] = await Promise.all([
      apiFetch<{
        data: { outbound: OutboundPolicy | null; inheritors: number };
      }>("/api/admin/crawl/default-outbound"),
      apiFetch<{ data: { transform: string; version: number } }>(
        "/api/settings/source-template",
      ),
      apiFetch<{data:CrawlSettingsValue}>("/api/admin/crawl/settings"),
    ]);
    schedule.value = config.data;
    baselineSchedule = JSON.stringify(schedule.value);
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
    if (tab.value === "schedule") {
      schedule.value = (await apiFetch<{data:CrawlSettingsValue}>("/api/admin/crawl/settings", {method:"PUT",body:schedule.value})).data;
      baselineSchedule=JSON.stringify(schedule.value);
    } else if (tab.value === "outbound") {
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
    description="调度配置全局生效；历史按页连续补齐，到期的日常增量穿插执行。"
    drawer
    :busy="busy"
    @close="close"
    ><form class="admin-dialog-form" @submit.prevent="save">
      <div class="admin-form-fields">
        <p v-if="loading" role="status">正在加载默认设置…</p>
        <template v-else
          ><Tabs v-model="tab"
            ><TabsList
              ><TabsTrigger value="schedule">调度配置</TabsTrigger><TabsTrigger value="outbound">默认出站策略</TabsTrigger
              ><TabsTrigger value="parser">默认解析模板</TabsTrigger></TabsList
            ></Tabs
          ><section v-if="tab === 'schedule'" class="schedule-fields">
              <label>同时采集频道数<Input v-model.number="schedule.concurrentChannels" type="number" min="1" max="32" required /></label>
              <small>所有 Worker 共用上限，同一频道始终只处理一页。</small>
              <label>每页等待时间（秒）<Input v-model.number="schedule.pageDelaySeconds" type="number" min="0" max="3600" required /></label>
              <small>同频道下一页最早启动时间，不影响其他频道；限频时遵守服务端退避。</small>
              <label>日常采集间隔（秒）<Input v-model.number="schedule.dailyIntervalSeconds" type="number" min="60" max="86400" required /></label>
              <small>默认 300 秒。历史不等待日常间隔，无总页数限制，完成后不周期重抓。</small>
            </section><template v-else-if="tab === 'outbound'"
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
              通用模板用于继承频道及独立的用户自定义频道搜索。修改后仅影响后续采集和失败页重试。
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
            : tab === "schedule" ? "保存调度配置" : tab === "outbound"
              ? "保存默认策略"
              : "保存解析模板"
        }}</Button>
      </footer>
    </form></AdminDialog
  >
</template>

<style scoped>
@layer components {.schedule-fields{display:grid;gap:12px}.schedule-fields label{display:grid;gap:8px}.schedule-fields small{color:var(--muted-foreground);line-height:1.6}}
</style>
