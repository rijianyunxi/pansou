<template>
  <section class="tg-stage-compare" aria-label="直连与 Jina 耗时对比">
    <div class="tg-stage-head">
      <h4>直连 / Jina 耗时对比</h4>
      <span v-if="elapsedLabel">本次总耗时 {{ elapsedLabel }}</span>
    </div>
    <p v-if="!rows.length" class="tg-stage-empty">
      本次结果未包含分阶段耗时（可能由旧版本接口返回）<template v-if="elapsedLabel">，总耗时 {{ elapsedLabel }}</template>。
    </p>
    <ul v-else class="tg-stage-rows">
      <li v-for="row in rows" :key="row.stage" :class="{ failed: !row.ok }">
        <div class="tg-stage-row-top">
          <strong>{{ row.label }}</strong>
          <span class="tg-stage-ms">{{ row.durationMs == null ? "—" : `${row.durationMs} ms` }}</span>
          <span class="tg-stage-bytes">{{ row.bytes == null ? "字符数 —" : formatTgCharCount(row.bytes) }}</span>
          <span class="tg-stage-ok" :class="row.ok ? 'ok' : 'bad'">{{ row.ok ? "拿到消息结构" : "未拿到消息结构" }}</span>
        </div>
        <div class="tg-stage-bar" aria-hidden="true">
          <i :class="row.ok ? 'ok' : 'bad'" :style="{ width: `${tgStageBarPercent(rows, row.durationMs)}%` }"></i>
        </div>
        <p v-if="row.error" class="tg-stage-error">{{ row.error }}</p>
        <p v-else-if="row.url" class="tg-stage-url">{{ row.url }}</p>
      </li>
    </ul>
    <p v-if="rows.length === 1" class="tg-stage-note">仅记录到一个阶段：另一线路可能未执行（fallback 策略限制）或未返回。</p>
    <p v-if="failureKind" class="tg-stage-failure" :class="failureTone">
      <strong>失败类别：{{ failureLabel }}</strong>
      <span>{{ failureDetail }}</span>
    </p>
  </section>
</template>
<script setup lang="ts">
import {
  failureKindDetail,
  failureKindLabel,
  failureKindTone,
  formatTgCharCount,
  normalizeTgStages,
  tgStageBarPercent,
} from "../../utils/telegramProbeView";

const props = defineProps<{
  stages?: unknown;
  failureKind?: string | null;
  elapsedMs?: number | null;
}>();

const rows = computed(() => normalizeTgStages(props.stages));
const elapsedLabel = computed(() =>
  props.elapsedMs != null && Number.isFinite(Number(props.elapsedMs))
    ? `${props.elapsedMs} ms`
    : "",
);
const failureLabel = computed(() => failureKindLabel(props.failureKind));
const failureDetail = computed(() => failureKindDetail(props.failureKind));
const failureTone = computed(() => failureKindTone(props.failureKind));
</script>
<style scoped>
.tg-stage-compare {
  display: grid;
  gap: 10px;
  min-width: 0;
}
.tg-stage-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.tg-stage-head h4 {
  margin: 0;
  font-size: 12px;
}
.tg-stage-head > span {
  color: #94a3b8;
  font: 10px ui-monospace, monospace;
  white-space: nowrap;
}
.tg-stage-rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 10px;
}
.tg-stage-rows li {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
  padding: 10px 12px;
  display: grid;
  gap: 7px;
  min-width: 0;
}
.tg-stage-rows li.failed {
  border-color: #fecaca;
  background: #fefbfb;
}
.tg-stage-row-top {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.tg-stage-row-top strong {
  font-size: 12px;
}
.tg-stage-ms {
  font: 11px ui-monospace, monospace;
  color: #334155;
}
.tg-stage-bytes {
  font: 10px ui-monospace, monospace;
  color: #64748b;
}
.tg-stage-ok {
  margin-left: auto;
  font-size: 10px;
  border-radius: 4px;
  padding: 2px 6px;
  white-space: nowrap;
}
.tg-stage-ok.ok {
  background: #eff6ff;
  color: #1d4ed8;
}
.tg-stage-ok.bad {
  background: #fef2f2;
  color: #b91c1c;
}
.tg-stage-bar {
  height: 7px;
  border-radius: 4px;
  background: #f1f5f9;
  overflow: hidden;
}
.tg-stage-bar i {
  display: block;
  height: 100%;
  border-radius: 4px;
  transition: width 0.2s ease;
}
.tg-stage-bar i.ok {
  background: #3b82f6;
}
.tg-stage-bar i.bad {
  background: #f87171;
}
.tg-stage-error {
  margin: 0;
  font-size: 10px;
  color: #b45309;
  overflow-wrap: anywhere;
}
.tg-stage-url {
  margin: 0;
  font: 10px ui-monospace, monospace;
  color: #94a3b8;
  overflow-wrap: anywhere;
}
.tg-stage-note {
  margin: 0;
  font-size: 10px;
  color: #94a3b8;
}
.tg-stage-empty {
  margin: 0;
  border: 1px dashed #cbd5e1;
  border-radius: 8px;
  padding: 14px;
  text-align: center;
  color: #94a3b8;
  font-size: 11px;
}
.tg-stage-failure {
  margin: 0;
  display: grid;
  gap: 3px;
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 11px;
}
.tg-stage-failure strong {
  font-size: 11px;
}
.tg-stage-failure.warn {
  background: #fffbeb;
  border: 1px solid #fde68a;
  color: #92400e;
}
.tg-stage-failure.bad {
  background: #fef2f2;
  border: 1px solid #fecaca;
  color: #b91c1c;
}
.tg-stage-failure.info {
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  color: #1d4ed8;
}
@media (max-width: 640px) {
  .tg-stage-ok {
    margin-left: 0;
  }
  .tg-stage-row-top strong {
    min-width: 72px;
  }
}
</style>
