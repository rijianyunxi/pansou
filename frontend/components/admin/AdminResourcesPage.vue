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
      <div class="resource-toolbar">
        <form class="resource-filters" @submit.prevent="page=1;loadResources()">
          <label class="resource-search"><ConsoleIcon name="search" :size="16" /><Input v-model.trim="query" type="search" class="tw:pl-9" aria-label="资源名称" placeholder="仅按资源名称查询" /></label>
          <AdminSelect v-model="cloudType" aria-label="网盘类型"><option value="">全部网盘</option><option v-for="type in cloudTypes" :key="type" :value="type">{{ cloudLabel(type) }}</option></AdminSelect>
          <Button variant="outline" type="submit" :disabled="loading">查询</Button>
          <Button v-if="query||cloudType" variant="ghost" type="button" @click="resetQuery">重置</Button>
        </form>
        <Button type="button" @click="openCreate"><ConsoleIcon name="plus" :size="16" />新增资源</Button>
      </div>
      <div class="resource-list-meta" :class="{'has-selection':selected.length}">
        <div v-if="selected.length" class="resource-batch" role="group" aria-label="批量操作">
          <span class="selection-count" aria-live="polite">已选 {{ selected.length }} 项</span>
          <div class="resource-batch-actions">
            <Button variant="outline" size="sm" :disabled="!canEnable||busy" @click="setEnabled(selected,true)"><CircleCheck aria-hidden="true" />启用</Button>
            <Button variant="outline" size="sm" :disabled="!canDisable||busy" @click="setEnabled(selected,false)"><Pause aria-hidden="true" />停用</Button>
            <Button variant="outline" size="sm" class="batch-delete" :disabled="busy" @click="deleteSelected"><Trash2 aria-hidden="true" />删除</Button>
            <Button variant="ghost" size="sm" class="batch-cancel" :disabled="busy" @click="selected=[]"><X aria-hidden="true" />取消选择</Button>
          </div>
        </div>
        <span class="resource-total">共 {{ total.toLocaleString('zh-CN') }} 条资源</span>
      </div>
      <Card class="table-panel resource-list-panel" aria-label="资源列表">
          <Table class="resource-list-table">
            <TableHeader><TableRow>
              <TableHead class="selection-col"><AdminCheckbox :checked="allSelected" :indeterminate="someSelected" aria-label="选择当前页全部资源" @change="toggleAll" /></TableHead>
              <TableHead class="name-col">资源</TableHead>
              <TableHead class="links-col">网盘链接</TableHead>
              <TableHead class="date-col">资源时间</TableHead>
              <TableHead class="state-col">状态</TableHead>
              <TableHead class="actions-col"><span class="tw:sr-only">操作</span></TableHead>
            </TableRow></TableHeader>
            <TableBody>
              <TableRow v-for="item in resources" :key="item.id" :class="{'selected-row':selected.includes(item.id)}">
                <TableCell class="tw:whitespace-normal"><AdminCheckbox :checked="selected.includes(item.id)" :aria-label="`选择 ${item.name}`" @change="toggle(item.id)" /></TableCell>
                <TableCell class="resource-name-cell tw:whitespace-normal">
                  <strong :title="item.name">{{ item.name }}</strong>
                  <ResourceDescription v-if="item.description" variant="admin" :text="item.description" />
                  <div v-if="item.tags?.length" class="resource-tags"><Badge v-for="tag in item.tags.slice(0,2)" :key="tag" variant="secondary" class="tw:rounded-md tw:font-normal" :title="tag">{{ tag }}</Badge><span v-if="item.tags.length>2" :title="item.tags.slice(2).join('、')">+{{item.tags.length-2}}</span></div>
                </TableCell>
                <TableCell class="tw:whitespace-normal">
                  <div class="resource-link-preview"><ResourceLinkTag v-for="(link,i) in item.links.slice(0,3)" :key="link.linkKey||i" :link="link" :checking="checkingLinks.has(link.linkKey||'')" :error="checkErrors[link.linkKey||'']" @open="openLinks(item,link.linkKey)" @check="checkLink(item,link)" /></div>
                  <Button v-if="item.links.length>3" variant="ghost" size="sm" class="all-links-button" :aria-label="`查看 ${item.name} 的全部 ${item.links.length} 条链接`" @click="openLinks(item)">查看全部 {{item.links.length}} 条链接<ChevronRight :size="14" /></Button>
                  <span v-if="!item.links.length" class="tw:text-muted-foreground">暂无链接</span>
                </TableCell>
                <TableCell class="resource-date tw:whitespace-normal">{{ item.datetime||'—' }}</TableCell>
                <TableCell class="tw:whitespace-normal"><Badge variant="outline" class="resource-status" :data-tone="item.enabled===false?'muted':'valid'"><span class="enabled-dot" aria-hidden="true" />{{item.enabled===false?'已停用':'已启用'}}</Badge></TableCell>
                <TableCell class="actions-col"><AdminRowActions :label="`${item.name}的操作`">
                  <Button variant="ghost" size="sm" class="row-action-button" :disabled="busy" @click="openEdit(item)">编辑</Button>
                  <Button variant="ghost" size="sm" class="row-action-button" :disabled="busy" @click="setEnabled([item.id],item.enabled===false)">{{item.enabled===false?'启用':'停用'}}</Button>
                  <Button variant="ghost" size="sm" class="row-action-button danger-action" :disabled="busy" @click="remove(item)">删除</Button>
                </AdminRowActions></TableCell>
              </TableRow>
              <TableRow v-if="!loading&&!resources.length"><TableCell colspan="6" class="empty-cell">{{query||cloudType?'没有匹配的资源':emptyLabel}}</TableCell></TableRow>
              <TableRow v-if="loading"><TableCell colspan="6" class="empty-cell">正在加载资源…</TableCell></TableRow>
            </TableBody>
          </Table>
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

    <ResourceLinksDrawer v-if="linkResource" :resource="linkResource" :initial-key="focusedLink" :checking="checkingLinks" :errors="checkErrors" @check="checkLink(linkResource,$event)" @close="linkResource=null" />
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
import {ChevronRight,CircleCheck,Pause,Trash2,X} from "@lucide/vue";
import {Badge} from "@/components/admin/ui/badge";
import ResourceLinkTag from "./ResourceLinkTag.vue";
import ResourceLinksDrawer from "./ResourceLinksDrawer.vue";
import type {AdminResourceLinkData} from "@/lib/adminResourceLinks";
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
import { computed, onMounted, onBeforeUnmount, ref } from "vue";
import { CLOUD_TYPE_SHORT_LABELS } from "~/shared/cloudTypes";

import ResourceDescription from "../ResourceDescription.vue";
import AdminPagination from "./AdminPagination.vue";
import ConsoleIcon from "../sources/ConsoleIcon.vue";
import type { CloudType, Link, ManagedResource } from "../../shared/apiModels";

type AdminResource = Omit<ManagedResource, "links"> & {
  links: AdminResourceLinkData[];
  enabled?: boolean;
};
const linkResource=ref<AdminResource|null>(null);
const focusedLink=ref<string>();
const checkingLinks=ref(new Set<string>());
const checkErrors=ref<Record<string,string>>({});
const checkControllers=new Map<string,AbortController>();
onBeforeUnmount(()=>{for(const controller of checkControllers.values())controller.abort();});
function openLinks(item:AdminResource,key?:string){focusedLink.value=key;linkResource.value=item;}
async function checkLink(item:AdminResource,link:AdminResourceLinkData){
 const key=link.linkKey;
 if(!key||!link.checkSupported||checkingLinks.value.has(key))return;
 checkingLinks.value.add(key);checkErrors.value[key]='';
 const controller=new AbortController();checkControllers.set(key,controller);
 const timeout=setTimeout(()=>controller.abort(),25000);
 try{
  const response=await apiFetch<{data:Partial<AdminResourceLinkData>&{message?:string}}>(`/api/admin/resources/${encodeURIComponent(item.id)}/links/check`,{method:'POST',body:{linkKey:key},signal:controller.signal});
  for(const resource of resources.value)for(const candidate of resource.links)if(candidate.linkKey===key)Object.assign(candidate,response.data);
  if(response.data.validity===-1)checkErrors.value[key]=response.data.message||'暂时无法确认，请稍后重试';
 }catch(error){checkErrors.value[key]=controller.signal.aborted?'检测超时，请重试':apiError(error);}
 finally{clearTimeout(timeout);checkControllers.delete(key);checkingLinks.value.delete(key);}
}
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

.resource-toolbar,.resource-filters,.resource-list-meta,.resource-batch,.resource-batch-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.resource-toolbar,.resource-list-meta{justify-content:space-between}
.resource-filters{flex:1;min-width:0}.resource-filters>:deep(button[role=combobox]){width:140px}
.resource-search{position:relative;flex:1;min-width:180px;max-width:420px}.resource-search svg{position:absolute;left:12px;top:12px;color:var(--muted-foreground)}.resource-search input{padding-left:36px}
.resource-list-meta{min-height:44px;font-size:13px;color:var(--muted-foreground);margin:8px 0}.resource-list-meta.has-selection{padding:8px 12px;border:1px solid var(--border);border-radius:8px;background:color-mix(in srgb,var(--muted) 40%,var(--background))}.resource-batch{gap:16px}.selection-count{color:var(--foreground);font-weight:500;white-space:nowrap}.resource-batch-actions{padding-left:16px;border-left:1px solid var(--border)}.resource-total{white-space:nowrap}.has-selection .resource-total{margin-left:auto}
.resource-list-panel :deep(.resource-list-table){width:100%;table-layout:fixed;min-width:800px;font-size:13px}
.resource-list-panel :deep(.resource-list-table th){height:44px;background:var(--muted);font-weight:500}.resource-list-panel :deep(.resource-list-table td){padding:16px 12px;vertical-align:top;white-space:normal}
.selection-col{width:44px}.name-col{width:auto}.links-col{width:36%}.date-col{width:140px}.state-col{width:96px}.actions-col{width:56px}
.resource-name-cell strong{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.5;font-size:14px;font-weight:600;overflow-wrap:anywhere}
.resource-name-cell :deep(.resource-description-toggle){color:var(--muted-foreground)}
.resource-tags{display:flex;gap:6px;align-items:center;margin-top:8px;min-width:0;font-size:12px;color:var(--muted-foreground)}.resource-tags :deep([data-slot=badge]){max-width:130px;display:block;overflow:hidden;text-overflow:ellipsis;border-radius:5px;font-weight:400}
.resource-link-preview{display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px;min-width:0;max-width:100%}.all-links-button{margin-top:6px;color:var(--muted-foreground);font-size:12px;padding:0 4px;height:28px}
.resource-date{font-variant-numeric:tabular-nums;color:var(--muted-foreground);font-size:12px;line-height:1.7;overflow-wrap:anywhere}
.enabled-dot{width:5px;height:5px;border-radius:50%;background:currentColor}.resource-list-panel{overflow:hidden}
.resource-form{display:grid;gap:16px}.resource-form label{display:grid;gap:6px;font-size:13px;font-weight:500}
.resource-links-title{display:flex;align-items:center;justify-content:space-between}.link-editor{display:grid;grid-template-columns:100px 1fr 110px 32px;gap:8px}
@media(max-width:700px){.resource-toolbar{align-items:stretch}.resource-filters{flex-basis:100%}.resource-search{max-width:none}.link-editor{grid-template-columns:1fr}.resource-batch{width:100%;gap:8px}.resource-batch-actions{border-left:0;padding-left:0}.selection-count{flex-basis:100%}.has-selection .resource-total{margin-left:0}}
}
</style>
