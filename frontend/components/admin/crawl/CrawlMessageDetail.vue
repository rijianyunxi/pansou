<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useCrawlQuery } from "@/composables/admin/useCrawlQuery";
import { useAdminConfirm } from "@/composables/admin/useAdminConfirm";
import { apiFetch, apiErrorMessage } from "@/src/appRuntime";
import {
  crawlTime,
  crawlStatus,
  type CrawlMessage,
  type ParsePreview,
  type CrawlChannel,
} from "@/types/crawl";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import CrawlResultCards from "./CrawlResultCards.vue";
const props = defineProps<{ channel: string; id: number }>();
const emit = defineEmits<{ back: []; task: [id: number] }>();
const { confirm } = useAdminConfirm();
const tab = ref("stored"),
  dsl = ref(""),
  preview = ref<ParsePreview | null>(null),
  previewError = ref(""),
  previewBusy = ref(false),
  reparseBusy = ref(false),
  reparseError = ref(""),
  queued = ref<number | null>(null);
const url = computed(
  () =>
    "/api/admin/crawl/channels/" +
    encodeURIComponent(props.channel) +
    "/messages/" +
    props.id,
);
const { data, loading, error, refresh } = useCrawlQuery<CrawlMessage>(
  url,
  ref({}),
  0,
);
const safeText = computed(() => data.value?.rawText || "");
onMounted(async () => {
  try {
    const c = (
      await apiFetch<{ data: CrawlChannel }>(
        "/api/admin/crawl/channels/" + encodeURIComponent(props.channel),
        { silentError: true },
      )
    ).data;
    if (c.transform != null) dsl.value = c.transform;
    else
      dsl.value = (
        await apiFetch<{ data: { transform: string } }>(
          "/api/settings/source-template",
          { silentError: true },
        )
      ).data.transform;
  } catch (e) {
    previewError.value = apiErrorMessage(e);
  }
});
watch(dsl, () => (preview.value = null));
async function runPreview() {
  if (previewBusy.value) return;
  previewBusy.value = true;
  previewError.value = "";
  try {
    preview.value = (
      await apiFetch<{ data: ParsePreview }>(url.value + "/preview", {
        method: "POST",
        body: { transform: dsl.value },
        silentError: true,
      })
    ).data;
  } catch (e) {
    previewError.value = apiErrorMessage(e);
  } finally {
    previewBusy.value = false;
  }
}
async function reparse() {
  if (
    reparseBusy.value ||
    !(await confirm(
      "用当前已保存的频道规则重解析此消息？未保存的预览 DSL 不会用于入库。",
    ))
  )
    return;
  reparseBusy.value = true;
  reparseError.value = "";
  try {
    queued.value = (
      await apiFetch<{ data: { id: number } }>(url.value + "/reparse", {
        method: "POST",
      })
    ).data.id;
  } catch (e) {
    reparseError.value = apiErrorMessage(e);
  } finally {
    reparseBusy.value = false;
  }
}
</script>
<template>
  <section class="message-detail">
    <div class="message-detail-toolbar">
      <Button type="button" variant="outline" size="sm" @click="emit('back')"
        >返回消息列表</Button
      ><Button type="button" variant="outline" size="sm" @click="refresh"
        >刷新已存结果</Button
      >
    </div>
    <p v-if="loading" role="status">正在加载消息详情…</p>
    <p v-if="error" role="alert" class="form-error">{{ error }}</p>
    <template v-if="data"
      ><div class="message-meta">
        <strong>@{{ channel }} / #{{ id }}</strong
        ><span
          >{{ crawlStatus(data.status) }} ·
          {{ crawlTime(data.publishedAt) }}</span
        ><small>已存解析版本：{{ data.parseVersion }}</small>
      </div>
      <p v-if="data.parseError" role="alert" class="form-error">
        {{ data.parseError }}
      </p>
      <Tabs v-model="tab"
        ><TabsList
          ><TabsTrigger value="stored">已存资源</TabsTrigger
          ><TabsTrigger value="preview">规则预览</TabsTrigger
          ><TabsTrigger value="raw">消息原文</TabsTrigger></TabsList
        ></Tabs
      >
      <section v-if="tab === 'stored'">
        <p class="message-help">
          这是消息来源关系的已存结果。人工覆盖 / 停用会影响最终可搜索资源。
        </p>
        <CrawlResultCards :results="data.stored?.map((s) => s.result) || []" />
        <p
          v-for="s in data.stored?.filter(
            (s) => s.manualOverride || !s.enabled || s.deleted,
          )"
          :key="s.result.id"
          class="message-help"
        >
          {{ s.result.name }}：{{ s.manualOverride ? "人工覆盖 " : ""
          }}{{ !s.enabled ? "停用 " : "" }}{{ s.deleted ? "已删除" : "" }}
        </p>
      </section>
      <section v-else-if="tab === 'preview'" class="preview-fields">
        <label
          >本次只读预览 DSL<Textarea v-model="dsl" rows="9" spellcheck="false"
        /></label>
        <p class="message-help">
          可测试未保存规则；预览不改资源、任务或索引。修改后旧预览失效。
        </p>
        <Button :disabled="previewBusy || !dsl" @click="runPreview">{{
          previewBusy ? "解析中…" : "执行只读预览"
        }}</Button>
        <p v-if="previewError" role="alert" class="form-error">
          {{ previewError }}
        </p>
        <template v-if="preview"
          ><p>预览状态：{{ crawlStatus(preview.status) }} · 尚未写入</p>
          <p v-if="preview.error" role="alert" class="form-error">
            {{ preview.error }}
          </p>
          <CrawlResultCards :results="preview.results"
        /></template>
      </section>
      <section v-else>
        <p class="message-help">只显示纯文本和转义代码，不执行 HTML。</p>
        <pre class="message-raw">{{ safeText }}</pre>
        <details>
          <summary>原始 HTML（转义）</summary>
          <pre class="message-raw">{{ data.rawHtml }}</pre>
        </details>
      </section>
      <p v-if="reparseError" role="alert" class="form-error">
        {{ reparseError }}
      </p>
      <div class="message-actions">
        <Button variant="outline" :disabled="reparseBusy" @click="reparse">{{
          reparseBusy ? "排队中…" : "重解析此消息"
        }}</Button
        ><Button v-if="queued" variant="outline" @click="emit('task', queued)"
          >任务 #{{ queued }} 已排队 · 查看</Button
        >
      </div></template
    >
  </section>
</template>
<style scoped>
@layer components {
  .message-detail {
    display: grid;
    gap: 18px;
    min-width: 0;
  }
  .message-detail-toolbar,
  .message-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .message-meta {
    display: grid;
    gap: 6px;
    font-size: 13px;
  }
  .message-meta small,
  .message-help {
    font-size: 12px;
    line-height: 1.7;
    color: var(--muted-foreground);
  }
  .message-help {
    margin-bottom: 12px;
  }
  .preview-fields {
    display: grid;
    gap: 14px;
    min-width: 0;
  }
  .preview-fields > label {
    display: grid;
    gap: 8px;
    font-size: 13px;
  }
  .preview-fields > button {
    justify-self: start;
  }
  .message-raw {
    background: var(--muted);
    padding: 16px;
    border-radius: 8px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 480px;
    overflow: auto;
    font-size: 12px;
  }
  .message-detail [data-slot="textarea"] {
    font-family: ui-monospace, monospace;
    font-size: 12px;
  }
}
</style>
