<template>
  <section class="source-template-panel" aria-label="用户频道来源模板">
    <details>
      <div class="template-grid">
        <label>请求 URL 模板<input v-model="draft.urlTemplate" placeholder="https://t.me/s/{{channel}}" /></label>
        <label>请求方式<select v-model="draft.method"><option value="GET">GET</option><option value="POST">POST</option></select></label>
        <label>响应格式<select v-model="draft.format"><option value="html">HTML</option><option value="json">JSON</option></select></label>
        <label class="wide">请求配置（JSON）<textarea v-model="requestText" rows="4" spellcheck="false" placeholder='{"headers":{"user-agent":"Mozilla/5.0"}}' /></label>
        <label class="wide">transform(payload, $, context)<textarea v-model="draft.transform" rows="10" spellcheck="false" /></label>
      </div>
      <div class="template-actions"><button class="button primary small" type="button" :disabled="loading || saving" @click="save">{{ saving ? '保存中…' : '保存模板' }}</button><span v-if="message" class="field-hint">{{ message }}</span><span v-if="error" class="form-error">{{ error }}</span></div>
    </details>
  </section>
</template>
<script setup lang="ts">
type Template = { urlTemplate: string; method: "GET" | "POST"; format: "html" | "json"; request: Record<string, unknown>; transform: string };
const defaults: Template = { urlTemplate: "", method: "GET", format: "html", request: {}, transform: "" };
const draft = reactive<Template>({ ...defaults });
const requestText = ref("{}");
const loading = ref(true), saving = ref(false), error = ref(""), message = ref("");
async function load() {
  loading.value = true;
  try { const response = await $fetch<{ data: Template }>("/api/settings/source-template"); Object.assign(draft, response.data); requestText.value = JSON.stringify(response.data.request || {}, null, 2); }
  catch (reason: any) { error.value = reason?.data?.statusMessage || reason?.message || "模板加载失败。"; }
  finally { loading.value = false; }
}
async function save() {
  saving.value = true; error.value = ""; message.value = "";
  try {
    const request = JSON.parse(requestText.value || "{}");
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("请求配置必须是 JSON 对象。");
    const response = await $fetch<{ data: Template }>("/api/settings/source-template", { method: "PUT", body: { ...draft, request } });
    Object.assign(draft, response.data); requestText.value = JSON.stringify(response.data.request || {}, null, 2); message.value = "模板已保存，下一次用户频道搜索立即生效。";
  } catch (reason: any) { error.value = reason?.data?.statusMessage || reason?.message || "模板保存失败。"; }
  finally { saving.value = false; }
}
onMounted(load);
</script>
<style scoped>
.source-template-panel { margin: 0 0 16px; border: 1px solid var(--border-light, #e4eaf1); border-radius: 12px; background: var(--bg-primary, #fff); padding: 14px 16px; }
summary { cursor: pointer; display: flex; gap: 12px; align-items: baseline; list-style: none; } summary::-webkit-details-marker { display: none; } summary span { color: var(--text-muted, #718096); font-size: 12px; }
.template-grid { display: grid; grid-template-columns: minmax(0, 2fr) 120px 120px; gap: 12px; margin-top: 14px; } label { display: grid; gap: 6px; color: var(--text-secondary, #475569); font-size: 12px; font-weight: 600; } .wide { grid-column: 1 / -1; }
input, select, textarea { width: 100%; box-sizing: border-box; border: 1px solid var(--border-light, #d8e0ea); border-radius: 7px; padding: 8px 10px; font: inherit; font-size: 12px; background: #fff; color: inherit; } textarea { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; resize: vertical; }
.template-actions { display: flex; align-items: center; gap: 10px; margin-top: 12px; } .form-error { color: #b42318; font-size: 12px; } @media (max-width: 760px) { .template-grid { grid-template-columns: 1fr; } .wide { grid-column: auto; } summary { flex-direction: column; gap: 4px; } }
</style>
