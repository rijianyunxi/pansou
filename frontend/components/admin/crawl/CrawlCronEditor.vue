<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import cronstrue from "cronstrue";
import "cronstrue/locales/zh_CN";
import { apiFetch, apiErrorMessage } from "@/src/appRuntime";
import { Input } from "../ui/input";
import { Button } from "../ui/button";

interface CronPreview {
  dailyCron: string;
  timeZone: string;
  nextRuns: string[];
  observedAt: string;
}
const expression = defineModel<string>({ required: true });
defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ validation: [valid: boolean] }>();
const preview = ref<CronPreview>();
const checking = ref(false), error = ref("");
let timer: ReturnType<typeof setTimeout> | undefined;
let controller: AbortController | undefined;
let revision = 0;
const description = computed(() => {
  if (!preview.value) return "";
  try {
    return cronstrue.toString(preview.value.dailyCron, {
      locale: "zh_CN", use24HourTimeFormat: true, verbose: true,
      dayOfWeekStartIndexZero: true, logicalAndDayFields: false,
    });
  } catch {
    return "表达式有效，执行时间如下。";
  }
});
const dateOrWeek = computed(() => {
  const fields = preview.value?.dailyCron.split(" ");
  return fields && !["*", "?"].includes(fields[3]) && !["*", "?"].includes(fields[5]);
});
const formatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function validate(immediate = false) {
  const value = expression.value.trim().split(/\s+/).join(" ");
  if (immediate && preview.value?.dailyCron === value && !error.value) return;
  clearTimeout(timer);
  controller?.abort();
  const current = ++revision;
  preview.value = undefined;
  error.value = "";
  emit("validation", false);
  if (!expression.value.trim() || value.split(" ").length !== 6) {
    checking.value = false;
    error.value = "请输入六段 cron：秒 分 时 日 月 周。";
    return;
  }
  if (value.length > 200) {
    checking.value = false;
    error.value = "cron 表达式最多 200 个字符。";
    return;
  }
  checking.value = true;
  const run = async () => {
    const request = new AbortController();
    controller = request;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; request.abort(); }, 10000);
    try {
      const result = await apiFetch<{ data: CronPreview }>("/api/admin/crawl/settings/preview", {
        method: "POST", body: { dailyCron: value }, signal: request.signal, silentError: true,
      });
      if (current !== revision) return;
      preview.value = result.data;
      emit("validation", true);
    } catch (e) {
      if (current !== revision) return;
      error.value = timedOut ? "校验超时，请重新校验。" : apiErrorMessage(e);
    } finally {
      clearTimeout(timeout);
      if (current === revision) { checking.value = false; controller = undefined; }
    }
  };
  if (immediate) void run();
  else timer = setTimeout(() => { void run(); }, 500);
}
watch(expression, () => validate(), { immediate: true, flush: "sync" });
onBeforeUnmount(() => {
  ++revision;
  clearTimeout(timer);
  controller?.abort();
});
</script>
<template>
  <section class="cron-editor" aria-labelledby="daily-cron-title">
    <label id="daily-cron-title" for="daily-cron-input">日常采集 Cron（北京时间）</label>
    <Input
      id="daily-cron-input"
      v-model="expression"
      placeholder="0 */10 8-21 * * *"
      maxlength="200"
      :disabled="disabled"
      :aria-invalid="!!error"
      aria-describedby="daily-cron-help daily-cron-feedback"
      autocomplete="off"
      spellcheck="false"
      required
      @blur="validate(true)"
    />
    <small id="daily-cron-help">六段：秒 分 时 日 月 周。例：0 */10 8-21 * * *，每天 08:00–21:50 每 10 分钟触发一次。</small>
    <div id="daily-cron-feedback" class="cron-feedback" aria-live="polite" :aria-busy="checking">
      <p v-if="checking" role="status">正在校验并解析执行时间…</p>
      <template v-else-if="preview">
        <p class="cron-description">{{ description }}</p>
        <small v-if="dateOrWeek">“日”和“周”任意一项匹配即可触发。</small>
        <p class="cron-times-title">接下来 5 次计划时间（北京时间）</p>
        <ol>
          <li v-for="time in preview.nextRuns" :key="time"><time :datetime="time">{{ formatter.format(new Date(time)) }}</time></li>
        </ol>
        <small>任务尚未完成时不会重复创建；超出所选小时、日期后暂停领取增量下一页。</small>
      </template>
      <p v-else-if="error" role="alert" class="form-error">{{ error }}</p>
    </div>
    <Button v-if="error" type="button" variant="outline" :disabled="disabled || checking" @click="validate(true)">重新校验</Button>
  </section>
</template>
<style scoped>
@layer components {
  .cron-editor { display: grid; gap: 10px; }
  .cron-editor label { font-weight: 500; }
  .cron-editor small { color: var(--muted-foreground); line-height: 1.6; }
  .cron-feedback { display: grid; gap: 8px; }
  .cron-feedback p { margin: 0; }
  .cron-description { font-weight: 500; }
  .cron-times-title { color: var(--muted-foreground); font-size: 13px; }
  .cron-feedback ol { margin: 0; padding-left: 24px; display: grid; gap: 6px; font-size: 13px; font-variant-numeric: tabular-nums; }
}
</style>
