<script setup lang="ts">
import { onMounted, ref } from "vue";
import { apiFetch, apiErrorMessage } from "@/src/appRuntime";
import { Input } from "../ui/input";
import type { CrawlSettingsValue } from "@/types/crawl";
import AdminDialog from "../AdminDialog.vue";
import CrawlCronEditor from "./CrawlCronEditor.vue";
import { useAdminConfirm } from "@/composables/admin/useAdminConfirm";
import { Button } from "../ui/button";
const emit = defineEmits<{ close: []; saved: [] }>();
const { confirm } = useAdminConfirm();
const schedule = ref<CrawlSettingsValue>({ concurrentChannels: 3, pageDelaySeconds: 3, dailyCron: "0 */10 * * * *", version: 1 });
const loading = ref(true), busy = ref(false), loaded = ref(false), error = ref("");
const cronValid = ref(false);
let baselineSchedule = "";
async function close() {
  if (busy.value) return;
  if (baselineSchedule && baselineSchedule !== JSON.stringify(schedule.value) &&
      !(await confirm("放弃尚未保存的采集调度设置？"))) return;
  emit("close");
}
onMounted(async () => {
  try {
    schedule.value = (await apiFetch<{ data: CrawlSettingsValue }>("/api/admin/crawl/settings")).data;
    baselineSchedule = JSON.stringify(schedule.value);
    loaded.value = true;
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    loading.value = false;
  }
});
async function save() {
  if (busy.value || !loaded.value || !cronValid.value) return;
  busy.value = true;
  error.value = "";
  try {
    schedule.value = (await apiFetch<{ data: CrawlSettingsValue }>("/api/admin/crawl/settings", {
      method: "PUT", body: schedule.value,
    })).data;
    baselineSchedule = JSON.stringify(schedule.value);
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
    description="调度配置全局生效；首次全量持续补齐，日常增量按计划执行。"
    drawer
    :busy="busy"
    @close="close"
  >
    <form class="admin-dialog-form" @submit.prevent="save">
      <div class="admin-form-fields">
        <p v-if="loading" role="status">正在加载调度设置…</p>
        <section v-else-if="loaded" class="schedule-fields">
          <label>同时采集频道数<Input v-model.number="schedule.concurrentChannels" type="number" min="1" max="32" required /></label>
          <small>所有 Worker 共用上限，同一频道始终只处理一页。</small>
          <label>每页等待时间（秒）<Input v-model.number="schedule.pageDelaySeconds" type="number" min="0" max="3600" required /></label>
          <small>同频道下一页最早启动时间，不影响其他频道；限频时遵守服务端退避。</small>
          <CrawlCronEditor v-model="schedule.dailyCron" :disabled="busy" @validation="cronValid = $event" />
          <small>首次全量和历史回填不受日常计划限制，按每页等待时间连续补齐，无总页数限制；完成后不周期重抓。</small>
        </section>
      </div>
      <footer class="modal-actions">
        <p v-if="error" role="alert" class="form-error">{{ error }}</p>
        <Button type="button" variant="outline" :disabled="busy" @click="close">关闭</Button>
        <Button :disabled="busy || loading || !loaded || !cronValid">{{ busy ? "保存中…" : "保存调度配置" }}</Button>
      </footer>
    </form>
  </AdminDialog>
</template>
<style scoped>
@layer components {
  .schedule-fields { display: grid; gap: 12px; }
  .schedule-fields label { display: grid; gap: 8px; }
  .schedule-fields small { color: var(--muted-foreground); line-height: 1.6; }
}
</style>
