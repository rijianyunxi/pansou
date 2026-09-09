<template>
  <dialog
    ref="dialog"
    class="source-dialog"
    aria-labelledby="editor-title"
    @close="$emit('close')"
    @click="onBackdrop"
  >
    <form class="editor-form" @submit.prevent="save">
      <header>
        <div>
          <span class="editor-kicker">UPSTREAM CONFIGURATION</span>
          <h2 id="editor-title">
            {{ source ? "编辑上游配置" : "连接一个新的上游" }}
          </h2>
        </div>
        <button
          type="button"
          class="icon-button"
          aria-label="关闭配置"
          @click="dialog?.close()"
        >
          <ConsoleIcon name="close" />
        </button>
      </header>
      <p class="editor-description">
        定义接口入口和适配方式。配置保存在当前浏览器，不会自动发布到搜索服务。
      </p>
      <label
        >上游名称 <span>*</span
        ><input
          v-model="form.name"
          required
          maxlength="40"
          placeholder="例如：我的资源接口"
          autofocus
      /></label>
      <label
        >接口地址 <span>*</span
        ><input
          v-model="form.url"
          required
          type="url"
          :readonly="source?.builtin"
          placeholder="https://api.example.com/search"
          maxlength="500"
        /><small>{{
          source?.builtin
            ? "内置执行地址由服务端白名单管理，此处不可修改。"
            : "仅保存配置，不会向此地址发送请求。请勿在 URL 中填写密钥。"
        }}</small></label
      >
      <div class="editor-grid">
        <label
          >请求方式<select v-model="form.method" :disabled="source?.builtin">
            <option>GET</option>
            <option>POST</option>
          </select></label
        ><label
          >响应格式<select v-model="form.format" :disabled="source?.builtin">
            <option value="json">JSON · 字段映射</option>
            <option value="html">HTML · 专用解析器</option>
          </select></label
        >
      </div>
      <label
        >描述<input
          v-model="form.description"
          maxlength="100"
          placeholder="描述这个接口的用途或资源类型"
      /></label>
      <div v-if="form.format === 'json'" class="mapping-compact">
        <h3>初始字段映射 <span>支持点路径</span></h3>
        <div class="editor-grid">
          <label
            >结果列表路径<input
              v-model="form.mapping.items"
              placeholder="data.list（空白表示根数组）" /></label
          ><label
            >标题字段<input
              v-model="form.mapping.title"
              placeholder="title"
              required /></label
          ><label
            >链接字段<input
              v-model="form.mapping.url"
              placeholder="url"
              required /></label
          ><label
            >提取码字段<input
              v-model="form.mapping.password"
              placeholder="password（可选）"
          /></label>
        </div>
      </div>
      <div class="editor-note">
        <ConsoleIcon name="shield" /><span
          >新增来源将标记为「配置草稿」。本版支持 JSON
          映射预览；自定义网络执行和服务端发布尚未开放。</span
        >
      </div>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <footer>
        <button type="button" class="button secondary" @click="dialog?.close()">
          取消</button
        ><button type="submit" class="button primary">
          <ConsoleIcon name="check" />{{
            source ? "保存本地配置" : "创建上游草稿"
          }}
        </button>
      </footer>
    </form>
  </dialog>
</template>
<script setup lang="ts">
import ConsoleIcon from "./ConsoleIcon.vue";
import type { UpstreamDefinition } from "../../config/upstreams";
const props = defineProps<{ source?: UpstreamDefinition | null }>();
const emit = defineEmits<{ close: []; save: [source: UpstreamDefinition] }>();
const dialog = ref<HTMLDialogElement>();
const error = ref("");
const form = reactive<UpstreamDefinition>(
  props.source
    ? JSON.parse(JSON.stringify(props.source))
    : {
        id: "",
        name: "",
        url: "",
        description: "",
        method: "GET",
        format: "json",
        plugin: "custom",
        adapter: "json-mapping",
        color: "#697fbd",
        initials: "C",
        mapping: {
          items: "data.list",
          title: "title",
          url: "url",
          password: "password",
          type: "type",
        },
        builtin: false,
      },
);
onMounted(() => dialog.value?.showModal());
function onBackdrop(event: MouseEvent) {
  if (!dialog.value || event.target !== dialog.value) return;
  const r = dialog.value.getBoundingClientRect();
  if (
    event.clientX < r.left ||
    event.clientX > r.right ||
    event.clientY < r.top ||
    event.clientY > r.bottom
  )
    dialog.value.close();
}
function save() {
  try {
    const url = new URL(form.url);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error();
  } catch {
    error.value = "请输入不含账户凭据的 HTTP 或 HTTPS 地址。";
    return;
  }
  if (!form.name.trim()) {
    error.value = "请填写上游名称。";
    return;
  }
  if (!form.id) form.id = `custom-${crypto.randomUUID()}`;
  form.name = form.name.trim();
  form.initials = form.name.charAt(0).toUpperCase();
  emit("save", JSON.parse(JSON.stringify(form)));
  dialog.value?.close();
}
</script>
