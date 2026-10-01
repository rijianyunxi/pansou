<template>
  <div class="admin-page admin-feature-app">
    <section class="feature-content">
      <p
        v-if="notice"
        class="feature-notice"
        :class="{ error: noticeError }"
        role="status"
      >
        {{ notice }}
      </p>
      <Card class="query-panel" aria-label="资源查询与操作">
        <div class="resource-view-hint">
          <ConsoleIcon name="database" :size="15" />
          <span
            >资源库由管理员直接维护，新增资源后立即进入列表和前台搜索。</span
          >
        </div>
        <form class="query-toolbar" @submit.prevent="loadResources">
          <label class="query-input">
            <ConsoleIcon name="search" :size="16" /><Input
              v-model.trim="query"
              type="search"
              placeholder="仅按资源名称查询"
            /> </label
          ><AdminSelect
            v-model="cloudType"
            class="query-select"
            aria-label="网盘类型"
          >
            <option value="">全部网盘</option>
            <option v-for="item in cloudTypes" :key="item" :value="item">
              {{ cloudLabel(item) }}
            </option>
          </AdminSelect>
          <div class="query-actions">
            <Button variant="default" class="button primary" type="submit">
              <ConsoleIcon name="search" :size="14" />查询 </Button
            ><Button
              variant="outline"
              class="button secondary"
              type="button"
              @click="resetQuery"
              >重置</Button
            ><Button
              variant="destructive"
              class="button danger-button"
              type="button"
              :disabled="!selected.length || busy"
              @click="deleteSelected"
              ><ConsoleIcon name="trash" :size="14" />批量删除<span
                v-if="selected.length"
                class="action-count"
                >{{ selected.length }}</span
              ></Button
            ><Button
              variant="outline"
              class="button secondary"
              type="button"
              :disabled="!canEnable || busy"
              @click="setEnabled(selected, true)"
              >批量启用</Button
            ><Button
              variant="destructive"
              class="button danger-button"
              type="button"
              :disabled="!canDisable || busy"
              @click="setEnabled(selected, false)"
              ><ConsoleIcon name="stop" :size="14" />批量停用</Button
            ><Button
              variant="default"
              class="button primary"
              type="button"
              @click="openCreate"
            >
              <ConsoleIcon name="plus" :size="14" />新增资源
            </Button>
          </div>
        </form>

        <div class="query-meta">
          已选 {{ selected.length }} 项 · 共 {{ total }} 条
        </div>
      </Card>
      <Card
        class="sources-panel directory-panel table-panel"
        aria-label="资源列表"
      >
        <div class="table-scroll">
          <Table class="source-table resource-table admin-data-table">
            <TableHeader>
              <TableRow>
                <TableHead class="checkbox-column"
                  ><AdminCheckbox
                    :checked="allSelected"
                    :indeterminate="someSelected"
                    aria-label="选择当前页全部资源"
                    @change="toggleAll"
                /></TableHead>
                <TableHead class="serial-column">序号</TableHead>
                <TableHead>名称</TableHead>
                <TableHead>网盘类型</TableHead>
                <TableHead>标签</TableHead>
                <TableHead>链接</TableHead>
                <TableHead>资源时间</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>检测状态</TableHead>
                <TableHead class="action-column">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow
                v-for="(item, index) in resources"
                :key="item.id"
                :class="{ 'selected-row': selected.includes(item.id) }"
              >
                <TableCell class="checkbox-column"
                  ><AdminCheckbox
                    :checked="selected.includes(item.id)"
                    :aria-label="`选择 ${item.name}`"
                    @change="toggle(item.id)"
                /></TableCell>
                <TableCell class="serial-column">{{
                  (page - 1) * pageSize + index + 1
                }}</TableCell>
                <TableCell
                  ><strong :title="item.name">{{ item.name }}</strong
                  ><ResourceDescription
                    variant="admin"
                    :text="item.description || '无描述'"
                /></TableCell>
                <TableCell
                  ><span
                    v-for="type in item.cloud_types"
                    :key="type"
                    class="resource-chip"
                    >{{ cloudLabel(type) }}</span
                  ></TableCell
                >
                <TableCell
                  ><span
                    v-for="tag in (item.tags || []).slice(0, 3)"
                    :key="tag"
                    class="resource-chip muted"
                    >{{ tag }}</span
                  ><span v-if="(item.tags || []).length > 3" class="table-muted"
                    >+{{ item.tags!.length - 3 }}</span
                  ></TableCell
                >
                <TableCell class="resource-links-cell">
                  <div
                    v-for="(link, linkIndex) in item.links"
                    :key="`${link.url}-${linkIndex}`"
                    class="resource-link-item"
                  >
                    <a
                      class="resource-link"
                      :href="link.url"
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      :title="link.url"
                    >
                      <span class="resource-link-type">{{
                        cloudLabel(link.type)
                      }}</span>
                      <span class="resource-link-url">{{ link.url }}</span>
                    </a>
                    <div class="resource-link-meta">
                      <span v-if="link.password" class="resource-link-password"
                        >提取码 {{ link.password }}</span
                      >
                    </div>
                  </div>
                </TableCell>
                <TableCell>{{ item.datetime || "—" }}</TableCell>
                <TableCell
                  ><span
                    class="resource-status"
                    :class="{ off: item.enabled === false }"
                    >{{ item.enabled === false ? "已停用" : "已启用" }}</span
                  ></TableCell
                >
                <TableCell
                  ><span
                    class="resource-check-status"
                    :class="`check-${item.linkValidity === 1 ? 'valid' : item.linkValidity === 0 ? 'invalid' : 'unchecked'}`"
                    title="至少一条有效则资源有效；全部明确失效才标记失效"
                    >{{ item.linkValidity === 1 ? '有效' : item.linkValidity === 0 ? '失效' : '未检测 / 待确认' }}</span
                  ><small v-if="item.linkValidityUpdatedAt">{{ new Date(item.linkValidityUpdatedAt).toLocaleString() }}</small></TableCell
                >
                <TableCell class="action-column">
                  <AdminRowActions
                    ><Button
                      variant="ghost"
                      size="sm"
                      class="row-action-button"
                      type="button"
                      :aria-label="`编辑 ${item.name}`"
                      title="编辑"
                      @click="openEdit(item)"
                    >
                      编辑</Button
                    ><Button
                      variant="ghost"
                      size="sm"
                      class="row-action-button"
                      :class="{ 'danger-action': item.enabled !== false }"
                      type="button"
                      :disabled="busy"
                      :title="
                        item.enabled === false
                          ? '重新出现在搜索结果里'
                          : '从搜索结果里隐藏，数据保留'
                      "
                      :aria-label="`${item.enabled === false ? '启用' : '停用'} ${item.name}`"
                      @click="setEnabled([item.id], item.enabled === false)"
                    >
                      {{ item.enabled === false ? "启用" : "停用" }} </Button
                    ><Button
                      variant="destructive"
                      size="sm"
                      class="row-action-button danger-action"
                      type="button"
                      :aria-label="`删除 ${item.name}`"
                      title="删除"
                      @click="remove(item)"
                    >
                      删除
                    </Button></AdminRowActions
                  >
                </TableCell>
              </TableRow>
              <TableRow v-if="!loading && !resources.length">
                <TableCell colspan="10" class="empty-cell"
                  >{{
                    query || cloudType
                      ? "没有名称匹配的资源。只匹配资源名称，不搜索描述或标签。"
                      : emptyLabel
                  }}
                </TableCell>
              </TableRow>
              <TableRow v-if="loading">
                <TableCell colspan="10" class="empty-cell"
                  >正在加载资源…</TableCell
                >
              </TableRow>
            </TableBody>
          </Table>
        </div>
        <AdminPagination
          :page="page"
          :total-pages="pageCount"
          :page-size="pageSize"
          :total="total"
          @change="goPage"
          @update:page-size="changePageSize"
        />
      </Card>
    </section>

    <AdminDialog
      :title="editing ? '编辑资源' : '新增资源'"
      description="维护资源信息与分享链接。带链接的资源才能被检索。"
      :busy="busy"
      drawer
      @close="closeDrawer"
      v-if="drawerOpen"
    >
      <section class="admin-modal resource-drawer">
        <form class="resource-form admin-dialog-form" @submit.prevent="save">
          <div class="admin-form-fields">
            <label
              >资源名称<Input
                v-model.trim="form.name"
                required
                maxlength="200"
                placeholder="例如：流浪地球 2" /></label
            ><label
              >描述<Textarea
                v-model.trim="form.description"
                rows="3"
                maxlength="5000"
                placeholder="可选"
              ></Textarea
            ></label>
            <div class="form-two-col">
              <label
                >资源时间<Input
                  v-model.trim="form.datetime"
                  maxlength="80"
                  placeholder="例如：2026-09-17" /></label
              ><label
                >标签<Input v-model="tagText" placeholder="多个标签用逗号分隔"
              /></label>
            </div>
            <div class="resource-links-title">
              <strong>网盘链接</strong
              ><Button
                variant="outline"
                class="button secondary"
                type="button"
                @click="addLink"
                >添加链接</Button
              >
            </div>
            <div
              v-for="(link, index) in form.links"
              :key="index"
              class="link-editor"
            >
              <AdminSelect v-model="link.type" aria-label="网盘类型">
                <option v-for="item in cloudTypes" :key="item" :value="item">
                  {{ cloudLabel(item) }}
                </option> </AdminSelect
              ><Input
                v-model.trim="link.url"
                required
                placeholder="分享链接"
                :aria-label="`第 ${index + 1} 条分享链接`"
              /><Input
                v-model.trim="link.password"
                placeholder="提取码（可选）"
                :aria-label="`第 ${index + 1} 条链接提取码`"
              /><Button
                variant="ghost"
                size="icon-sm"
                class="icon-button"
                type="button"
                :disabled="form.links.length === 1"
                :aria-label="`删除第 ${index + 1} 条链接`"
                @click="removeLink(index)"
                >×</Button
              >
            </div>
            <label
              >图片地址<Input
                v-model="imageText"
                placeholder="多个图片 URL 用逗号分隔"
            /></label>
            <p role="alert" v-if="formError" class="form-error">
              {{ formError }}
            </p>
          </div>
          <div class="modal-actions">
            <Button
              variant="outline"
              class="button secondary"
              type="button"
              @click="closeDrawer"
              >取消</Button
            ><Button
              variant="default"
              class="button primary"
              type="submit"
              :disabled="busy"
              >{{ busy ? "保存中…" : "保存资源" }}</Button
            >
          </div>
        </form>
      </section>
    </AdminDialog>
  </div>
</template>
<script setup lang="ts">
import AdminRowActions from "@/components/admin/AdminRowActions.vue";
import { Card } from "@/components/admin/ui/card";
import { Button } from "@/components/admin/ui/button";
import { Input } from "@/components/admin/ui/input";
import { Textarea } from "@/components/admin/ui/textarea";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/admin/ui/table";
import AdminSelect from "@/components/admin/AdminSelect.vue";
import AdminCheckbox from "@/components/admin/AdminCheckbox.vue";
import AdminDialog from "@/components/admin/AdminDialog.vue";
import { useAdminConfirm } from "@/composables/admin/useAdminConfirm";
const { confirm: confirmAction } = useAdminConfirm();
import { useAdminSession } from "@/composables/admin/useAdminSession";
const { locked } = useAdminSession();

import { apiFetch } from "../../src/appRuntime";
import { computed, onMounted, ref } from "vue";
import { CLOUD_TYPE_SHORT_LABELS } from "~/shared/cloudTypes";

import ResourceDescription from "../ResourceDescription.vue";
import AdminPagination from "./AdminPagination.vue";
import ConsoleIcon from "../sources/ConsoleIcon.vue";
import type { CloudType, Link, ManagedResource } from "../../shared/apiModels";

type AdminResource = ManagedResource & {
  createdAt?: number;
  updatedAt?: number;
  enabled?: boolean;
  checkStatus?: "unchecked" | "checking" | "valid" | "invalid" | "unknown";
  checkMessage?: string | null;
  checkedAt?: string | null;
  linkValidity?: -1 | 0 | 1;
  linkValidityUpdatedAt?: string | null;
};
const cloudTypes = ref<CloudType[]>([]);
const resources = ref<AdminResource[]>([]);
const query = ref("");
const cloudType = ref("");
const page = ref(1);
const pageSize = ref(20);
const total = ref(0);
const selected = ref<string[]>([]);
const loading = ref(false);
const busy = ref(false);
const notice = ref("");
const noticeError = ref(false);
const drawerOpen = ref(false);
const editing = ref(false);
const formError = ref("");
const tagText = ref("");
const imageText = ref("");
const cloudDeleteBusyKey = ref("");
const deleteRequests = new Map<string, {resourceId:string;linkIndex:number;confirmationToken:string;requestKey:string}>();
const form = ref<{
  id?: string;
  name: string;
  description: string;
  datetime: string;
  links: Array<{ type: CloudType; url: string; password: string }>;
}>({
  name: "",
  description: "",
  datetime: "",
  links: [{ type: "baidu", url: "", password: "" }],
});
const pageCount = computed(() =>
  Math.max(1, Math.ceil(total.value / pageSize.value)),
);
const currentKeys = computed(() => resources.value.map((item) => item.id));
const allSelected = computed(
  () =>
    currentKeys.value.length > 0 &&
    currentKeys.value.every((id) => selected.value.includes(id)),
);
const someSelected = computed(
  () =>
    selected.value.some((id) => currentKeys.value.includes(id)) &&
    !allSelected.value,
);
const emptyLabel = "还没有资源，点击右上角新增资源。";
// Selection is trimmed to the current page on every load, so the batch enable and
// disable buttons can tell whether they would actually change anything.
const selectedItems = computed(() =>
  resources.value.filter((item) => selected.value.includes(item.id)),
);
const canEnable = computed(() =>
  selectedItems.value.some((item) => item.enabled === false),
);
const canDisable = computed(() =>
  selectedItems.value.some((item) => item.enabled !== false),
);
function cloudLabel(type: string) {
  return CLOUD_TYPE_SHORT_LABELS[type as CloudType] || type;
}
function checkStatusLabel(status?: AdminResource["checkStatus"]) {
  return status === "valid"
    ? "正常"
    : status === "invalid"
      ? "已失效"
      : status === "unknown"
        ? "待确认"
        : status === "checking"
          ? "检测中"
          : "未检测";
}
function statusOf(error: any) {
  return error?.statusCode || error?.response?.status || error?.status;
}
function apiError(error: any) {
  const status = statusOf(error);
  return status === 401
    ? "请先登录管理员账号。"
    : status === 403
      ? "当前账号没有管理员权限。"
      : error?.data?.statusMessage || error?.message || "后台请求失败。";
}
function show(message: string, error = false) {
  notice.value = message;
  noticeError.value = error;
}

async function loadResources() {
  loading.value = true;
  try {
    const result = await apiFetch<any>("/api/admin/resources", {
      query: {
        q: query.value || undefined,
        cloudType: cloudType.value || undefined,
        page: page.value,
        pageSize: pageSize.value,
      },
      cache: "no-store",
    });
    const data = result?.data ?? result;
    resources.value = data.items || [];
    total.value = Number(data.total || 0);
    cloudTypes.value = data.cloudTypes || cloudTypes.value;
    selected.value = selected.value.filter((id) =>
      currentKeys.value.includes(id),
    );
  } catch (e: any) {
    show(apiError(e), true);
    if (statusOf(e) === 401) locked.value = true;
  } finally {
    loading.value = false;
  }
}
function resetQuery() {
  query.value = "";
  cloudType.value = "";
  page.value = 1;
  void loadResources();
}
function goPage(next: number) {
  if (next >= 1 && next <= pageCount.value && next !== page.value) {
    page.value = next;
    void loadResources();
  }
}
function changePageSize(size: number) {
  pageSize.value = size;
  page.value = 1;
  void loadResources();
}
function toggle(id: string) {
  selected.value = selected.value.includes(id)
    ? selected.value.filter((item) => item !== id)
    : [...selected.value, id];
}
function toggleAll(event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  selected.value = checked
    ? [...new Set([...selected.value, ...currentKeys.value])]
    : selected.value.filter((id) => !currentKeys.value.includes(id));
}
function blank() {
  return {
    name: "",
    description: "",
    datetime: "",
    links: [
      {
        type: (cloudTypes.value[0] || "baidu") as CloudType,
        url: "",
        password: "",
      },
    ],
  };
}
function openCreate() {
  editing.value = false;
  formError.value = "";
  form.value = blank();
  tagText.value = "";
  imageText.value = "";
  drawerOpen.value = true;
}
function openEdit(item: AdminResource) {
  editing.value = true;
  formError.value = "";
  form.value = {
    id: item.id,
    name: item.name,
    description: item.description || "",
    datetime: item.datetime || "",
    links: item.links.map((link: Link) => ({
      type: link.type,
      url: link.url,
      password: link.password || "",
    })),
  };
  tagText.value = (item.tags || []).join(", ");
  imageText.value = (item.images || []).join(", ");
  drawerOpen.value = true;
}
function closeDrawer() {
  if (!busy.value) drawerOpen.value = false;
}
function addLink() {
  form.value.links.push({
    type: (cloudTypes.value[0] || "baidu") as CloudType,
    url: "",
    password: "",
  });
}
function removeLink(index: number) {
  if (form.value.links.length > 1) form.value.links.splice(index, 1);
}
async function save() {
  if (busy.value) return;
  formError.value = "";
  busy.value = true;
  const isCreating = !editing.value;
  const body = {
    name: form.value.name,
    description: form.value.description || null,
    datetime: form.value.datetime || null,
    links: form.value.links,
    tags: tagText.value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    images: imageText.value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  };
  try {
    await apiFetch(
      isCreating
        ? "/api/admin/resources"
        : `/api/admin/resources/${encodeURIComponent(form.value.id!)}`,
      { method: isCreating ? "POST" : "PUT", body },
    );
    drawerOpen.value = false;
    if (isCreating) {
      page.value = 1;
      selected.value = [];
    }
    show(isCreating ? "资源已加入资源库。" : "资源已更新。");
    await loadResources();
  } catch (e: any) {
    formError.value = apiError(e);
  } finally {
    busy.value = false;
  }
}
async function remove(item: AdminResource) {
  if (busy.value || !(await confirmAction(`确定删除「${item.name}」吗？`)))
    return;
  busy.value = true;
  try {
    await apiFetch(`/api/admin/resources/${encodeURIComponent(item.id)}`, {
      method: "DELETE",
    });
    selected.value = selected.value.filter((id) => id !== item.id);
    page.value = Math.min(
      page.value,
      Math.max(1, Math.ceil((total.value - 1) / pageSize.value)),
    );
    show("资源已删除。");
    await loadResources();
  } catch (e: any) {
    show(apiError(e), true);
  } finally {
    busy.value = false;
  }
}
async function deleteSelected() {
  if (
    !selected.value.length ||
    !(await confirmAction(`确定删除选中的 ${selected.value.length} 条资源吗？`))
  )
    return;
  busy.value = true;
  try {
    await apiFetch("/api/admin/resources/batch-delete", {
      method: "POST",
      body: { ids: selected.value },
    });
    const count = selected.value.length;
    selected.value = [];
    page.value = Math.min(
      page.value,
      Math.max(1, Math.ceil((total.value - count) / pageSize.value)),
    );
    show(`已删除 ${count} 条资源。`);
    await loadResources();
  } catch (e: any) {
    show(apiError(e), true);
  } finally {
    busy.value = false;
  }
}
async function setEnabled(ids: string[], enabled: boolean) {
  const targets = [...new Set(ids)].filter(Boolean);
  if (!targets.length || busy.value) return;
  if (
    targets.length > 1 &&
    !(await confirmAction(
      `确定${enabled ? "启用" : "停用"}选中的 ${targets.length} 条资源吗？`,
    ))
  )
    return;
  busy.value = true;
  try {
    const result = await apiFetch<any>("/api/admin/resources/enabled", {
      method: "POST",
      body: { ids: targets, enabled },
    });
    const count = Number(result?.data?.count ?? 0);
    show(
      count
        ? `已${enabled ? "启用" : "停用"} ${count} 条资源。`
        : "所选资源已经是该状态，未做改动。",
    );
    await loadResources();
  } catch (e: any) {
    show(apiError(e), true);
  } finally {
    busy.value = false;
  }
}
onMounted(loadResources);
</script>
<style scoped>
@layer components {
  .resource-view-hint {
    display: flex;
    align-items: flex-start;
    gap: 7px;
    padding: 10px 16px;
    color: #64748b;
    background: #fbfcfe;
    font-size: 11px;
    line-height: 1.5;
  }

  .resource-view-hint :deep(svg) {
    flex: 0 0 auto;
    margin-top: 1px;
    color: #2563eb;
  }

  .action-count {
    min-width: 17px;
    padding: 1px 5px;
    border-radius: 99px;
    color: currentColor;
    background: rgba(255, 255, 255, 0.35);
    font-size: 10px;
    text-align: center;
  }

  .resource-chip {
    display: inline-block;
    margin: 2px 4px 2px 0;
    padding: 2px 6px;
    border-radius: 4px;
    color: #2563eb;
    background: #eff6ff;
    font-size: 10px;
  }

  .resource-chip.muted {
    color: #64748b;
    background: #f1f5f9;
  }

  .resource-links-cell {
    min-width: 230px;
    max-width: 340px;
    white-space: normal !important;
  }

  .resource-link-item + .resource-link-item {
    margin-top: 7px;
  }

  .resource-link {
    display: flex;
    align-items: center;
    min-width: 0;
    gap: 6px;
    color: #2563eb;
    text-decoration: none;
  }

  .resource-link:hover {
    color: #1d4ed8;
    text-decoration: underline;
  }

  .resource-link-type {
    flex: 0 0 auto;
    padding: 2px 5px;
    border-radius: 4px;
    color: #2563eb;
    background: #eff6ff;
    font-size: 10px;
  }

  .resource-link-url {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .resource-link-meta {
    display: flex;
    align-items: center;
    gap: 7px;
    min-height: 16px;
    margin-top: 3px;
  }

  .resource-link-password {
    margin-top: 0;
    color: #64748b;
    font-size: 10px;
  }

  .resource-link-delete {
    padding: 0;
    border: 0;
    color: #b91c1c;
    background: transparent;
    font-size: 10px;
    cursor: pointer;
  }

  .resource-link-delete:hover {
    color: #7f1d1d;
    text-decoration: underline;
  }

  .resource-link-delete:disabled {
    color: #cbd5e1;
    cursor: not-allowed;
  }

  .table-muted {
    color: #94a3b8;
    font-size: 11px;
  }

  .resource-status {
    display: inline-block;
    padding: 2px 7px;
    border-radius: 4px;
    color: #0f6e56;
    background: #e1f5ee;
    font-size: 10px;
    white-space: nowrap;
  }

  .resource-status.off {
    color: #64748b;
    background: #f1f5f9;
  }

  .resource-check-status {
    display: inline-block;
    padding: 2px 7px;
    border-radius: 4px;
    color: #64748b;
    background: #f1f5f9;
    font-size: 10px;
    white-space: nowrap;
  }

  .resource-check-status.check-valid {
    color: #0f6e56;
    background: #e1f5ee;
  }

  .resource-check-status.check-invalid {
    color: #b42318;
    background: #fee4e2;
  }

  .resource-check-status.check-unknown,
  .resource-check-status.check-checking {
    color: #9a6700;
    background: #fff4ce;
  }

  .check-message {
    display: block;
    max-width: 160px;
    margin-top: 4px;
    overflow: hidden;
    color: #94a3b8;
    font-size: 10px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The shared `.row-actions` rule is a wrapping flex row, which stacked the three
   row buttons on top of each other once this table gained more columns. Match
   the source directory instead: one compact row, left aligned, never wrapping. */

  .resource-table td.action-column {
    padding: 8px 9px;
  }

  .resource-drawer {
    width: min(680px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    overflow: auto;
  }

  .eyebrow {
    display: block;
    margin: 0 0 7px;
    color: #2563eb;
    font:
      700 10px ui-monospace,
      SFMono-Regular,
      Consolas,
      monospace;
    letter-spacing: 1.6px;
  }

  .resource-form {
    display: grid;
    gap: 14px;
  }

  .resource-form label {
    display: grid;
    gap: 6px;
    color: #475569;
    font-size: 12px;
    font-weight: 600;
  }

  .resource-form input,
  .resource-form textarea,
  .resource-form select {
    width: 100%;
    padding: 9px 10px;
    border: 1px solid #dbe1ea;
    border-radius: 7px;
    background: #fff;
    color: #111827;
    font-weight: 400;
  }

  .resource-links-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .link-editor {
    display: grid;
    grid-template-columns: 110px 1fr 120px 32px;
    gap: 7px;
  }

  @media (max-width: 700px) {
    .link-editor {
      grid-template-columns: 1fr;
    }

    .resource-drawer {
      width: calc(100vw - 20px);
    }
  }

  .resource-table td:nth-child(3) > strong {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
</style>
