<script setup lang="ts">
import { ref } from "vue";
import type { CrawlChannel } from "@/types/crawl";
import { crawlKind } from "@/types/crawl";
import { apiFetch, apiErrorMessage } from "@/src/appRuntime";
import AdminDialog from "../AdminDialog.vue";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
const requestKey = crypto.randomUUID();
const props = defineProps<{ channel: CrawlChannel; kind: string }>();
const emit = defineEmits<{ close: []; queued: [id: number] }>();
const budget = ref(500),
  busy = ref(false),
  error = ref("");
async function submit() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const r = await apiFetch<{ data: { id: number } }>(
      "/api/admin/crawl/channels/" +
        encodeURIComponent(props.channel.id) +
        "/jobs",
      {
        method: "POST",
        body: { kind: props.kind, requestKey, maxPages: budget.value },
      },
    );
    emit("queued", r.data.id);
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <AdminDialog
    :title="crawlKind(kind) + ' · @' + channel.id"
    description="提交成功仅表示已排队，需要 worker 执行。"
    :busy="busy"
    @close="emit('close')"
    ><form class="admin-dialog-form" @submit.prevent="submit">
      <div class="admin-form-fields">
        <p class="tw:text-sm tw:text-muted-foreground">
          {{
            kind === "backfill"
              ? "从已保存的检查点继续历史；公开网页可访问边界不等于完整历史。"
              : kind === "reparse"
                ? "只处理数据库已有原文，不抓取 Telegram 页面。"
                : "处理公开频道消息，任务预算不是完成百分比。"
          }}
        </p>
        <label
          >{{ kind === "reparse" ? "最多原文批数" : "最多抓取页数"
          }}<Input
            v-model.number="budget"
            type="number"
            min="1"
            max="10000"
            required
        /></label>
      </div>
      <footer class="modal-actions">
        <p v-if="error" role="alert" class="form-error">{{ error }}</p>
        <Button
          type="button"
          variant="outline"
          :disabled="busy"
          @click="emit('close')"
          >取消</Button
        ><Button :disabled="busy">{{ busy ? "排队中…" : "提交任务" }}</Button>
      </footer>
    </form></AdminDialog
  >
</template>
