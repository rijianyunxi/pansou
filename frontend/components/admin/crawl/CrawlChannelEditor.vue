<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useAdminConfirm } from "@/composables/admin/useAdminConfirm";
import { apiFetch, apiErrorMessage } from "@/src/appRuntime";
import { directPolicy } from "@/types/outbound";
import type { CrawlChannel } from "@/types/crawl";
import AdminDialog from "../AdminDialog.vue";
import OutboundPolicyEditor from "../OutboundPolicyEditor.vue";
import AdminCheckbox from "../AdminCheckbox.vue";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
const props = defineProps<{ id?: string }>();
const emit = defineEmits<{ close: []; saved: [id: string] }>();
const { confirm } = useAdminConfirm();
const tab = ref("basic"),
  loading = ref(!!props.id),
  busy = ref(false),
  loaded = ref(false),
  error = ref("");
const form = ref({
  id: props.id || "",
  name: "",
  description: "",
  enabled: true,
  transform: "",
  outbound: directPolicy(),
  expectedVersion: 0,
});
let baseline = "";
const dirty = computed(
  () => baseline !== "" && JSON.stringify(form.value) !== baseline,
);
async function close() {
  if (busy.value) return;
  if (dirty.value && !(await confirm("关闭并放弃尚未保存的频道配置？"))) return;
  emit("close");
}
async function load() {
  loading.value = true;
  error.value = "";
  try {
    if (props.id) {
      const c = (
        await apiFetch<{ data: CrawlChannel }>(
          "/api/admin/crawl/channels/" + encodeURIComponent(props.id),
          { silentError: true },
        )
      ).data;
      form.value = {
        id: c.id,
        name: c.name || c.id,
        description: c.description,
        enabled: c.enabled,
        transform: c.transform || "",
        outbound: c.outbound || directPolicy(),
        expectedVersion: c.version,
      };
    }
    baseline = JSON.stringify(form.value);
    loaded.value = true;
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    loading.value = false;
  }
}
async function save() {
  if (busy.value) return;
  if (!form.value.name.trim()) {
    error.value = "频道显示名称必填";
    tab.value = "basic";
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    const f = form.value;
    const r = await apiFetch<{ data: { id: string } }>(
      props.id
        ? "/api/admin/crawl/channels/" + encodeURIComponent(props.id)
        : "/api/admin/crawl/channels",
      {
        method: props.id ? "PUT" : "POST",
        body: {
          id: f.id,
          name: f.name,
          description: f.description,
          enabled: f.enabled,
          transform: f.transform.trim() ? f.transform : null,
          outbound: f.outbound,
          expectedVersion: f.expectedVersion,
        },
      },
    );
    emit("saved", r.data.id);
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    busy.value = false;
  }
}
onMounted(load);
</script>
<template>
  <AdminDialog
    :title="id ? '编辑 TG 频道' : '新增 TG 频道'"
    description="维护用于采集入库的系统频道，搜索直接读取本地资源。暂停不会删除数据。"
    drawer
    :busy="busy"
    @close="close"
    ><form class="admin-dialog-form" @submit.prevent="save">
      <div class="admin-form-fields">
        <p v-if="loading" role="status">正在加载频道配置…</p>
        <template v-else
          ><Tabs v-model="tab"
            ><TabsList
              ><TabsTrigger value="basic">基本设置</TabsTrigger
              ><TabsTrigger value="crawl">采集与代理</TabsTrigger
              ><TabsTrigger value="parser">解析规则</TabsTrigger></TabsList
            ></Tabs
          >
          <section v-if="tab === 'basic'" class="channel-editor-fields">
            <label
              >公开频道 username / URL<Input
                v-model="form.id"
                required
                :readonly="!!id"
                placeholder="@channel 或 https://t.me/s/channel" /></label
            ><small v-if="id">频道身份不可直接改名复用历史。</small
            ><label
              >显示名称<Input
                v-model="form.name"
                required
                maxlength="240" /></label
            ><label
              >备注<Textarea
                v-model="form.description"
                rows="3"
                maxlength="4000"
            /></label>
          </section>
          <section v-else-if="tab === 'crawl'" class="channel-editor-fields">
            <label class="channel-check"
              ><AdminCheckbox v-model="form.enabled" />允许采集</label
            ><OutboundPolicyEditor
              v-model="form.outbound"
              :disabled="busy"
            />
          </section>
          <section v-else class="channel-editor-fields">
            <label>Rust transform DSL<Textarea
                v-model="form.transform"
                rows="15"
                spellcheck="false"
                placeholder="留空使用内置 TG 解析规则"
                class="channel-code"
            /></label>
            <p class="channel-help">
              留空使用内置 TG 解析规则。此配置仅用于当前频道；修改规则仅影响后续采集；失败页重试会重新抓取并使用当前规则解析。
            </p>
          </section></template
        >
      </div>
      <footer class="modal-actions">
        <p v-if="error" role="alert" class="form-error">{{ error }}</p>
        <Button type="button" variant="outline" :disabled="busy" @click="close"
          >取消</Button
        ><Button type="submit" :disabled="busy || loading || !loaded">{{
          busy ? "保存中…" : "保存频道"
        }}</Button>
      </footer>
    </form></AdminDialog
  >
</template>
<style scoped>
@layer components {
  .channel-editor-fields {
    display: grid;
    gap: 18px;
    min-width: 0;
  }
  .channel-editor-fields > label:not(.channel-check) {
    display: grid;
    gap: 7px;
    font-size: 13px;
    font-weight: 500;
  }
  .channel-check {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
  }
  .channel-check small {
    display: block;
    color: var(--muted-foreground);
  }
  .channel-help {
    font-size: 12px;
    line-height: 1.7;
    color: var(--muted-foreground);
  }

  .channel-code {
    font-family: ui-monospace, monospace;
    font-size: 12px;
    min-height: 300px;
  }
}
</style>
