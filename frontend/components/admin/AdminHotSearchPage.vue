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
      <Card class="query-panel" aria-label="热门搜索查询与操作">
        <form class="query-toolbar" @submit.prevent="loadSearches">
          <label class="query-input"
            ><ConsoleIcon name="search" :size="16" /><Input
              v-model.trim="query"
              type="search"
              placeholder="搜索热门词"
          /></label>
          <AdminSelect
            v-model="status"
            class="query-select"
            aria-label="热门搜索状态"
            ><option value="">全部状态</option>
            <option value="approved">已通过</option>
            <option value="pending">待审核</option>
            <option value="blocked">已屏蔽</option>
            <option value="hidden">已隐藏</option></AdminSelect
          >
          <AdminSelect
            v-model="source"
            class="query-select"
            aria-label="热门搜索来源"
            ><option value="">全部来源</option>
            <option value="auto">自动</option>
            <option value="manual">人工</option></AdminSelect
          >
          <div class="query-actions">
            <Button variant="default" class="button primary" type="submit"
              ><ConsoleIcon name="search" :size="14" />查询</Button
            ><Button
              variant="outline"
              class="button secondary"
              type="button"
              @click="resetQuery"
              >重置</Button
            ><Button
              variant="outline"
              class="button secondary"
              type="button"
              :disabled="!selected.length || busy"
              @click="changeStatus('approved')"
              >恢复</Button
            ><Button
              variant="destructive"
              class="button danger-button"
              type="button"
              :disabled="!selected.length || busy"
              @click="changeStatus('blocked')"
              ><ConsoleIcon name="lock" :size="14" />屏蔽</Button
            ><Button
              variant="outline"
              class="button secondary"
              type="button"
              :disabled="!selected.length || busy"
              @click="setPinned(true)"
              >置顶</Button
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
              variant="default"
              class="button primary"
              type="button"
              @click="openHotSearch()"
              ><ConsoleIcon name="plus" :size="14" />新增热门词</Button
            >
          </div>
        </form>
        <div class="query-meta">
          已选 {{ selected.length }} 项 · 共 {{ total }} 条
        </div>
      </Card>
      <Card
        class="sources-panel directory-panel table-panel"
        aria-label="热门搜索列表"
      >
        <div class="table-scroll">
          <Table class="source-table admin-data-table hot-search-table"
            ><TableHeader
              ><TableRow
                ><TableHead class="checkbox-column"
                  ><AdminCheckbox
                    :checked="allSelected"
                    :indeterminate="someSelected"
                    aria-label="选择当前页全部热门词"
                    @change="toggleAll" /></TableHead
                ><TableHead>排名</TableHead><TableHead>关键词</TableHead
                ><TableHead>热度</TableHead><TableHead>状态</TableHead
                ><TableHead>来源</TableHead><TableHead>更新时间</TableHead
                ><TableHead>操作</TableHead></TableRow
              ></TableHeader
            >
            <TableBody
              ><TableRow
                v-for="(item, index) in items"
                :key="item.term"
                :class="{ 'selected-row': selected.includes(item.term) }"
                ><TableCell class="checkbox-column"
                  ><AdminCheckbox
                    :checked="selected.includes(item.term)"
                    :aria-label="`选择 ${item.term}`"
                    @change="toggle(item.term)" /></TableCell
                ><TableCell
                  >{{ (page - 1) * pageSize + index + 1
                  }}<span v-if="item.pinned" class="pin-mark"
                    >置顶</span
                  ></TableCell
                ><TableCell
                  ><strong>{{ item.term }}</strong></TableCell
                ><TableCell
                  >{{ item.score
                  }}<small v-if="item.manualWeight" class="table-muted"
                    >人工权重 {{ item.manualWeight }}</small
                  ></TableCell
                ><TableCell
                  ><AdminStatusBadge :state="item.status">{{ statusLabel(item.status) }}</AdminStatusBadge
                  ></TableCell
                ><TableCell>{{
                  item.source === "manual" ? "人工" : "自动"
                }}</TableCell
                ><TableCell>{{
                  formatTime(item.updatedAt || item.lastSearched)
                }}</TableCell
                ><TableCell class="action-column"
                  ><AdminRowActions
                    ><Button
                      variant="ghost"
                      size="sm"
                      class="row-action-button"
                      type="button"
                      title="编辑"
                      :aria-label="`编辑 ${item.term}`"
                      @click="openHotSearch(item)"
                      >编辑</Button
                    ><Button
                      variant="ghost"
                      size="sm"
                      class="row-action-button"
                      :class="{ 'danger-action': item.status === 'approved' }"
                      type="button"
                      :title="item.status === 'approved' ? '屏蔽' : '恢复'"
                      :aria-label="`${item.status === 'approved' ? '屏蔽' : '恢复'} ${item.term}`"
                      @click="
                        changeOneStatus(
                          item,
                          item.status === 'approved' ? 'blocked' : 'approved',
                        )
                      "
                      >{{
                        item.status === "approved" ? "屏蔽" : "恢复"
                      }}</Button
                    ><Button
                      variant="destructive"
                      size="sm"
                      class="row-action-button danger-action"
                      type="button"
                      title="删除"
                      :aria-label="`删除 ${item.term}`"
                      @click="remove(item)"
                      >删除</Button
                    ></AdminRowActions
                  ></TableCell
                ></TableRow
              ><TableRow v-if="!loading && !items.length"
                ><TableCell colspan="8" class="empty-cell"
                  >暂无热门搜索数据。</TableCell
                ></TableRow
              ><TableRow v-if="loading"
                ><TableCell colspan="8" class="empty-cell"
                  >正在加载热门搜索…</TableCell
                ></TableRow
              ></TableBody
            >
          </Table>
        </div>
        <AdminPagination
          :page="page"
          :total-pages="pageCount"
          :total="total"
          :page-size="pageSize"
          @change="goPage"
          @update:page-size="changePageSize"
        />
      </Card>
    </section>

    <AdminDialog
      :title="editingHot ? '编辑热门词' : '新增热门词'"
      :busy="busy"
      @close="closeDialogs"
      v-if="hotDialog"
      ><section class="admin-modal">
        <form
          class="resource-form admin-dialog-form"
          @submit.prevent="saveHotSearch"
        >
          <div class="admin-form-fields">
            <label
              >关键词<Input
                v-model.trim="hotForm.term"
                required
                maxlength="100"
                placeholder="输入要展示的热门搜索词"
            /></label>
            <div class="form-two-col">
              <label
                >状态<AdminSelect v-model="hotForm.status"
                  ><option value="approved">已通过</option>
                  <option value="pending">待审核</option>
                  <option value="blocked">已屏蔽</option>
                  <option value="hidden">已隐藏</option></AdminSelect
                ></label
              ><label
                >热度<Input
                  v-model.number="hotForm.score"
                  type="number"
                  min="0"
                  max="2000000000"
              /></label>
            </div>
            <div class="form-two-col">
              <label
                >人工权重<Input
                  v-model.number="hotForm.manualWeight"
                  type="number"
                  min="0"
                  max="1000000" /></label
              ><label class="checkbox-field"
                ><Switch v-model="hotForm.pinned" />置顶展示</label
              >
            </div>
            <p role="alert" v-if="formError" class="form-error">
              {{ formError }}
            </p>
          </div>
          <div class="modal-actions">
            <Button
              variant="outline"
              class="button secondary"
              type="button"
              @click="closeDialogs"
              >取消</Button
            ><Button
              variant="default"
              class="button primary"
              type="submit"
              :disabled="busy"
              >{{ busy ? "保存中…" : "保存" }}</Button
            >
          </div>
        </form>
      </section></AdminDialog
    >
  </div>
</template>

<script setup lang="ts">
import AdminRowActions from "@/components/admin/AdminRowActions.vue";
import { Switch } from "@/components/admin/ui/switch";
import AdminStatusBadge from "./AdminStatusBadge.vue";
import { Card } from "@/components/admin/ui/card";
import { Button } from "@/components/admin/ui/button";
import { Input } from "@/components/admin/ui/input";
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

import AdminPagination from "./AdminPagination.vue";
import ConsoleIcon from "../sources/ConsoleIcon.vue";
import type { HotSearchItem, HotSearchStatus } from "../../types/hotSearch";

const items = ref<HotSearchItem[]>([]);
const query = ref("");
const status = ref("");
const source = ref("");
const page = ref(1);
const pageSize = ref(20);
const total = ref(0);
const selected = ref<string[]>([]);
const loading = ref(false);
const busy = ref(false);
const notice = ref("");
const noticeError = ref(false);
const formError = ref("");
const hotDialog = ref(false);
const editingHot = ref(false);
const hotForm = ref({
  term: "",
  status: "approved" as HotSearchStatus,
  score: 0,
  manualWeight: 0,
  pinned: false,
  oldTerm: "",
});
const pageCount = computed(() =>
  Math.max(1, Math.ceil(total.value / pageSize.value)),
);
const currentKeys = computed(() => items.value.map((item) => item.term));
const allSelected = computed(
  () =>
    currentKeys.value.length > 0 &&
    currentKeys.value.every((term) => selected.value.includes(term)),
);
const someSelected = computed(
  () =>
    selected.value.some((term) => currentKeys.value.includes(term)) &&
    !allSelected.value,
);
function statusLabel(value: string) {
  return (
    (
      {
        approved: "已通过",
        pending: "待审核",
        blocked: "已屏蔽",
        hidden: "已隐藏",
      } as Record<string, string>
    )[value] || value
  );
}
function formatTime(value: number) {
  return value
    ? new Date(value).toLocaleString("zh-CN", { hour12: false })
    : "—";
}
function statusOf(error: any) {
  return error?.statusCode || error?.response?.status || error?.status;
}
function apiError(error: any) {
  const statusCode = statusOf(error);
  return statusCode === 401
    ? "请先登录管理员账号。"
    : statusCode === 403
      ? "当前账号没有管理员权限。"
      : error?.data?.statusMessage || error?.message || "后台请求失败。";
}
function show(message: string, error = false) {
  notice.value = message;
  noticeError.value = error;
}

async function loadSearches() {
  loading.value = true;
  try {
    const result = await apiFetch<any>("/api/admin/hot-searches", {
      query: {
        q: query.value || undefined,
        status: status.value || undefined,
        source: source.value || undefined,
        page: page.value,
        pageSize: pageSize.value,
      },
      cache: "no-store",
    });
    const data = result?.data ?? result;
    items.value = data.items || [];
    total.value = Number(data.total || 0);
    selected.value = selected.value.filter((term) =>
      currentKeys.value.includes(term),
    );
  } catch (error: any) {
    show(apiError(error), true);
    if (statusOf(error) === 401) locked.value = true;
  } finally {
    loading.value = false;
  }
}
function resetQuery() {
  query.value = "";
  status.value = "";
  source.value = "";
  page.value = 1;
  void loadSearches();
}
function goPage(next: number) {
  if (next >= 1 && next <= pageCount.value && next !== page.value) {
    page.value = next;
    void loadSearches();
  }
}
function changePageSize(size: number) {
  pageSize.value = size;
  page.value = 1;
  void loadSearches();
}
function toggle(term: string) {
  selected.value = selected.value.includes(term)
    ? selected.value.filter((item) => item !== term)
    : [...selected.value, term];
}
function toggleAll(event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  selected.value = checked
    ? [...new Set([...selected.value, ...currentKeys.value])]
    : selected.value.filter((term) => !currentKeys.value.includes(term));
}
async function changeStatus(next: HotSearchStatus) {
  if (!selected.value.length || busy.value) return;
  busy.value = true;
  try {
    const result = await apiFetch<any>("/api/admin/hot-searches/status", {
      method: "POST",
      body: { terms: selected.value, status: next },
    });
    show(`已更新 ${Number(result?.data?.count || 0)} 条热门词。`);
    selected.value = [];
    await loadSearches();
  } catch (error: any) {
    show(apiError(error), true);
  } finally {
    busy.value = false;
  }
}
async function changeOneStatus(item: HotSearchItem, next: HotSearchStatus) {
  selected.value = [item.term];
  await changeStatus(next);
}
async function setPinned(pinned: boolean) {
  if (!selected.value.length || busy.value) return;
  busy.value = true;
  try {
    const result = await apiFetch<any>("/api/admin/hot-searches/pinned", {
      method: "POST",
      body: { terms: selected.value, pinned },
    });
    show(`已更新 ${Number(result?.data?.count || 0)} 条热门词。`);
    selected.value = [];
    await loadSearches();
  } catch (error: any) {
    show(apiError(error), true);
  } finally {
    busy.value = false;
  }
}
function openHotSearch(item?: HotSearchItem) {
  editingHot.value = !!item;
  formError.value = "";
  hotForm.value = item
    ? {
        term: item.term,
        oldTerm: item.term,
        status: item.status,
        score: item.score,
        manualWeight: item.manualWeight,
        pinned: item.pinned,
      }
    : {
        term: "",
        oldTerm: "",
        status: "approved",
        score: 0,
        manualWeight: 0,
        pinned: false,
      };
  hotDialog.value = true;
}
function closeDialogs() {
  if (!busy.value) hotDialog.value = false;
}
async function saveHotSearch() {
  busy.value = true;
  formError.value = "";
  try {
    const body = {
      term: hotForm.value.term,
      status: hotForm.value.status,
      score: hotForm.value.score,
      manualWeight: hotForm.value.manualWeight,
      pinned: hotForm.value.pinned,
    };
    await apiFetch(
      editingHot.value
        ? `/api/admin/hot-searches/${encodeURIComponent(hotForm.value.oldTerm)}`
        : "/api/admin/hot-searches",
      { method: editingHot.value ? "PUT" : "POST", body },
    );
    hotDialog.value = false;
    show(editingHot.value ? "热门词已更新。" : "热门词已添加。");
    await loadSearches();
  } catch (error: any) {
    formError.value = apiError(error);
  } finally {
    busy.value = false;
  }
}
async function remove(item: HotSearchItem) {
  if (busy.value || !(await confirmAction(`确定永久删除「${item.term}」吗？`)))
    return;
  busy.value = true;
  try {
    await apiFetch(`/api/admin/hot-searches/${encodeURIComponent(item.term)}`, {
      method: "DELETE",
    });
    selected.value = selected.value.filter((term) => term !== item.term);
    show("热门词已删除。");
    await loadSearches();
  } catch (error: any) {
    show(apiError(error), true);
  } finally {
    busy.value = false;
  }
}
async function deleteSelected() {
  if (
    !selected.value.length ||
    busy.value ||
    !(await confirmAction(
      "确定永久删除选中的 " + selected.value.length + " 条热门词吗？",
    ))
  )
    return;
  busy.value = true;
  try {
    const terms = [...selected.value];
    const result = await apiFetch<any>("/api/admin/hot-searches/batch-delete", {
      method: "POST",
      body: { terms },
    });
    const count = Number(result?.data?.count || 0);
    selected.value = [];
    page.value = Math.min(
      page.value,
      Math.max(1, Math.ceil((total.value - count) / pageSize.value)),
    );
    show("已删除 " + count + " 条热门词。");
    await loadSearches();
  } catch (error: any) {
    show(apiError(error), true);
  } finally {
    busy.value = false;
  }
}
onMounted(loadSearches);
</script>
<style scoped>
@layer components {
  .hot-search-table th,
  .hot-search-table td {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hot-search-table th:nth-child(1),
  .hot-search-table td:nth-child(1) {
    width: 42px;
  }
  .hot-search-table th:nth-child(2),
  .hot-search-table td:nth-child(2) {
    width: 8%;
  }
  .hot-search-table th:nth-child(3),
  .hot-search-table td:nth-child(3) {
    width: 24%;
  }
  .hot-search-table th:nth-child(4),
  .hot-search-table td:nth-child(4) {
    width: 9%;
  }
  .hot-search-table th:nth-child(5),
  .hot-search-table td:nth-child(5) {
    width: 11%;
  }
  .hot-search-table th:nth-child(6),
  .hot-search-table td:nth-child(6) {
    width: 9%;
  }
  .hot-search-table th:nth-child(7),
  .hot-search-table td:nth-child(7) {
    width: 11%;
  }
  .hot-search-table th:nth-child(8),
  .hot-search-table td:nth-child(8) {
    width: 16%;
  }
  .hot-search-table th:nth-child(9),
  .hot-search-table td:nth-child(9) {
    width: 14%;
  }
  .hot-search-table td:nth-child(3),
  .hot-search-table td:nth-child(8) {
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .resource-form {
    display: grid;
    gap: 14px;
    padding: 22px;
  }
  .resource-form > label {
    display: grid;
    gap: 7px;
    color: #475569;
    font-size: 12px;
    font-weight: 600;
  }
  .resource-form input,
  .resource-form select,
  .resource-form textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 10px 12px;
    border: 1px solid #dce5f0;
    border-radius: 9px;
    outline: 0;
    color: #111827;
    background: #fff;
    font: inherit;
    font-size: 12px;
  }
  .resource-form textarea {
    resize: vertical;
  }
  .hot-search-table small {
    display: block;
    margin-top: 4px;
  }
  .pin-mark {
    display: inline-block;
    margin-left: 6px;
    padding: 2px 5px;
    border-radius: 4px;
    background: #fff7ed;
    color: #c2410c;
    font-size: 10px;
  }
  .checkbox-field {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-top: 28px;
  }
  .checkbox-field input {
    width: auto;
  }
  .table-muted {
    color: #718096;
    font-size: 11px;
  }
  /* Keep the labelled action group from being compressed by the fixed table layout. */
  .hot-search-table th:nth-child(8),
  .hot-search-table td:nth-child(8) {
    width: 21%;
  }
}
</style>
