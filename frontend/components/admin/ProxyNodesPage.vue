<script setup lang="ts">
import { onMounted, ref } from "vue";
import { apiFetch, apiErrorMessage } from "@/src/appRuntime";
import { useAdminConfirm } from "@/composables/admin/useAdminConfirm";
import type { ProxyNode } from "@/types/outbound";
import AdminDialog from "./AdminDialog.vue";
import AdminRowActions from "./AdminRowActions.vue";
import AdminCheckbox from "./AdminCheckbox.vue";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "./ui/table";
const nodes = ref<ProxyNode[]>([]),
  loading = ref(true),
  error = ref(""),
  notice = ref(""),
  busy = ref(false),
  editing = ref(false);
const { confirm } = useAdminConfirm();
const form = ref({
  id: "",
  name: "",
  baseUrl: "",
  enabled: true,
  dailyLimit: 0,
});
const references = ref<
    | {
        sourceId?: string;
        channelId?: string;
        name: string;
        default: boolean;
      }[]
    | null
  >(null),
  refsLoading = ref(false),
  refsError = ref("");
async function load() {
  loading.value = true;
  error.value = "";
  try {
    nodes.value = (
      await apiFetch<{ data: { nodes: ProxyNode[] } }>("/api/admin/proxies", {
        silentError: true,
      })
    ).data.nodes;
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    loading.value = false;
  }
}
function edit(n?: ProxyNode) {
  error.value = "";
  form.value = n
    ? {
        id: n.id,
        name: n.name,
        baseUrl: n.baseUrl,
        enabled: n.enabled,
        dailyLimit: n.dailyLimit,
      }
    : { id: "", name: "", baseUrl: "", enabled: true, dailyLimit: 0 };
  editing.value = true;
}
async function save() {
  if (busy.value) return;
  if (!form.value.name.trim() || !form.value.baseUrl.trim()) {
    error.value = "名称和节点地址必填";
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    await apiFetch(
      form.value.id
        ? "/api/admin/proxies/" + encodeURIComponent(form.value.id)
        : "/api/admin/proxies",
      { method: form.value.id ? "PUT" : "POST", body: form.value },
    );
    editing.value = false;
    notice.value = "节点已保存；所有引用者共用节点状态与额度。";
    await load();
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function act(n: ProxyNode, action: "toggle" | "reset" | "delete") {
  if (busy.value) return;
  const message =
    action === "delete"
      ? "删除节点 " + n.name + "？仍有引用时后端将拒绝删除。"
      : action === "toggle"
        ? "切换节点 " +
          n.name +
          " 的启用状态？影响 " +
          n.referenceCount +
          " 个引用，引用不会被移除。"
        : "重置 " + n.name + " 的熔断状态？这不代表线路已经验证可用。";
  if (!(await confirm(message))) return;
  busy.value = true;
  error.value = "";
  try {
    await apiFetch(
      "/api/admin/proxies/" +
        encodeURIComponent(n.id) +
        (action === "reset" ? "/reset" : ""),
      {
        method:
          action === "reset" ? "POST" : action === "delete" ? "DELETE" : "PUT",
        body: action === "toggle" ? { ...n, enabled: !n.enabled } : undefined,
      },
    );
    notice.value = "节点操作已完成。";
    await load();
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function showRefs(n: ProxyNode) {
  references.value = [];
  refsLoading.value = true;
  refsError.value = "";
  try {
    references.value = (
      await apiFetch<{ data: { items: NonNullable<typeof references.value> } }>(
        "/api/admin/proxies/" + encodeURIComponent(n.id) + "/references",
        { silentError: true },
      )
    ).data.items;
  } catch (e) {
    refsError.value = apiErrorMessage(e);
  } finally {
    refsLoading.value = false;
  }
}
function state(n: ProxyNode) {
  return !n.enabled
    ? "已停用"
    : n.dailyLimit > 0 && n.quotaUsed >= n.dailyLimit
      ? "额度耗尽"
      : n.circuitState === "open"
        ? "熔断中"
        : "已启用";
}
onMounted(load);
</script>
<template>
  <div class="admin-page node-library">
    <div class="query-toolbar">
      <p class="node-note">
        这里只维护节点。访问策略在实时来源与 TG 频道中配置。
      </p>
      <Button variant="outline" :disabled="loading" @click="load">刷新</Button
      ><Button @click="edit()">新增节点</Button>
    </div>
    <p v-if="notice" role="status" class="feature-notice">{{ notice }}</p>
    <p v-if="error && !editing" role="alert" class="form-error">{{ error }}</p>
    <p v-if="loading" role="status" class="admin-loading">正在加载节点…</p>
    <Card class="table-panel"
      ><Table class="admin-data-table"
        ><TableHeader
          ><TableRow
            ><TableHead>节点</TableHead><TableHead>今日用量</TableHead
            ><TableHead>状态</TableHead><TableHead>引用</TableHead
            ><TableHead>最近错误</TableHead
            ><TableHead>操作</TableHead></TableRow
          ></TableHeader
        ><TableBody
          ><TableRow v-for="n in nodes" :key="n.id"
            ><TableCell
              ><strong>{{ n.name }}</strong>
              <p class="node-address">
                {{
                  n.kind === "direct" ? "直接访问目标 · 内置节点" : n.baseUrl
                }}
              </p></TableCell
            ><TableCell
              >{{ n.quotaUsed }} / {{ n.dailyLimit || "不限" }}</TableCell
            ><TableCell>{{ state(n) }}</TableCell
            ><TableCell
              ><Button variant="ghost" size="sm" @click="showRefs(n)"
                >{{ n.referenceCount }} 个引用</Button
              ></TableCell
            ><TableCell
              ><p class="node-error">{{ n.lastError || "—" }}</p></TableCell
            ><TableCell
              ><AdminRowActions v-if="n.kind !== 'direct'"
                ><Button variant="outline" :disabled="busy" @click="edit(n)"
                  >编辑节点</Button
                ><Button
                  variant="outline"
                  :disabled="busy"
                  @click="act(n, 'toggle')"
                  >{{ n.enabled ? "停用" : "启用" }}</Button
                ><Button
                  variant="outline"
                  :disabled="busy"
                  @click="act(n, 'reset')"
                  >重置熔断</Button
                ><Button
                  variant="destructive"
                  :disabled="busy || n.referenceCount > 0"
                  @click="act(n, 'delete')"
                  >删除节点</Button
                ></AdminRowActions
              ></TableCell
            ></TableRow
          ><TableRow v-if="!loading && !nodes.length"
            ><TableCell colspan="6"
              >暂无节点。新增节点后到来源或频道中配置访问策略。</TableCell
            ></TableRow
          ></TableBody
        ></Table
      ></Card
    >
    <AdminDialog
      v-if="editing"
      :title="form.id ? '编辑节点' : '新增节点'"
      description="修改节点地址与状态会影响所有引用者，额度全局共享。"
      :busy="busy"
      @close="editing = false"
      ><form class="admin-dialog-form" @submit.prevent="save">
        <div class="admin-form-fields">
          <label>节点名称<Input v-model="form.name" required /></label
          ><label
            >HTTP 转发服务地址<Input
              v-model="form.baseUrl"
              required
              type="url"
              placeholder="https://proxy.example.com" /></label
          ><label
            >全局每日额度（0 不限）<Input
              v-model.number="form.dailyLimit"
              type="number"
              min="0" /></label
          ><label class="node-checkbox"
            ><AdminCheckbox v-model="form.enabled" />启用节点</label
          >
          <p class="node-note">这里不配置节点权重、来源或频道绑定。</p>
        </div>
        <footer class="modal-actions">
          <p v-if="error" role="alert" class="form-error">{{ error }}</p>
          <Button
            type="button"
            variant="outline"
            :disabled="busy"
            @click="editing = false"
            >取消</Button
          ><Button type="submit" :disabled="busy">{{
            busy ? "保存中…" : "保存节点"
          }}</Button>
        </footer>
      </form></AdminDialog
    >
    <AdminDialog
      v-if="references !== null"
      title="节点引用"
      description="引用只读；策略请在所属来源或频道中维护。"
      drawer
      @close="references = null"
      ><section class="reference-list">
        <p v-if="refsLoading" role="status">正在加载引用…</p>
        <p v-else-if="refsError" role="alert">{{ refsError }}</p>
        <p v-else-if="!references.length">没有引用，可安全删除。</p>
        <article v-for="(r, i) in references" :key="i">
          <strong>{{
            r.name || r.channelId || r.sourceId || "TG 默认策略"
          }}</strong
          ><RouterLink
            :to="
              r.sourceId
                ? '/admin/sources?edit=' + encodeURIComponent(r.sourceId)
                : r.channelId
                  ? '/admin/crawl?edit=' + encodeURIComponent(r.channelId)
                  : '/admin/crawl?settings=1'
            "
            >{{
              r.sourceId ? "实时来源" : r.channelId ? "TG 频道" : "TG 默认策略"
            }}
            →</RouterLink
          >
        </article>
      </section></AdminDialog
    >
  </div>
</template>
<style scoped>
@layer components {
  .node-library {
    display: grid;
    gap: 18px;
  }
  .node-note {
    font-size: 13px;
    line-height: 1.7;
    color: var(--muted-foreground);
    flex: 1;
  }
  .node-address {
    font-size: 12px;
    color: var(--muted-foreground);
    max-width: 340px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .node-error {
    max-width: 240px;
    overflow-wrap: anywhere;
    font-size: 12px;
  }
  .node-checkbox {
    display: flex !important;
    align-items: center;
    gap: 8px;
  }
  .reference-list {
    padding: 24px;
    display: grid;
    gap: 16px;
  }
  .reference-list article {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 12px;
  }
  .node-library table {
    min-width: 820px;
  }
}
</style>
