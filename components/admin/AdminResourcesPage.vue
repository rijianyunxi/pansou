<template>
  <div class="source-app admin-feature-app">
    <AdminAccessGate v-if="checking || locked" :checking="checking" :authenticated="authenticated" :error="authError"
      title="进入网盘资源管理" @authenticated="checkStatus" />
    <template v-else>
      <aside class="console-sidebar">
        <NuxtLink to="/" class="console-brand"><span class="brand-symbol">
            <ConsoleIcon name="box" :size="22" />
          </span>PanHub <span class="brand-tag">CONSOLE</span></NuxtLink>
        <nav aria-label="后台导航">
          <NuxtLink to="/admin/monitor" class="console-nav-link">
            <ConsoleIcon name="activity" />运行监控
          </NuxtLink>
          <NuxtLink to="/admin/sources" class="console-nav-link">
            <ConsoleIcon name="box" />来源管理
          </NuxtLink>
          <NuxtLink to="/admin/proxies" class="console-nav-link">
            <ConsoleIcon name="globe" />代理节点
          </NuxtLink>
          <NuxtLink to="/admin/resources" class="console-nav-link active">
            <ConsoleIcon name="database" />网盘资源
          </NuxtLink>
          <NuxtLink to="/admin/hot-searches" class="console-nav-link">
            <ConsoleIcon name="search" />热门搜索
          </NuxtLink>
          <NuxtLink to="/admin/users" class="console-nav-link">
            <ConsoleIcon name="user" />用户管理
          </NuxtLink>
          <NuxtLink to="/admin/logs" class="console-nav-link">
            <ConsoleIcon name="activity" />搜索日志
          </NuxtLink>
          <NuxtLink to="/admin/policies" class="console-nav-link">
            <ConsoleIcon name="sliders" />系统设置
          </NuxtLink>
        </nav>
      </aside>
      <div class="console-body">
        <header class="console-topbar">
          <div class="breadcrumbs">
            <ConsoleIcon name="grid" :size="16" /><span>管理后台</span>
            <ConsoleIcon name="chevron" :size="13" /><strong>网盘资源管理</strong>
          </div>
          <div class="topbar-right">
            <button class="session-button" type="button" @click="lock">
              <span>退出后台</span>
              <ConsoleIcon name="logout" :size="15" />
            </button>
          </div>
        </header>
        <main class="console-main admin-feature-main">
          <section class="feature-content">
            <p v-if="notice" class="feature-notice" :class="{ error: noticeError }" role="status">{{ notice }}</p>
            <section class="query-panel" aria-label="资源查询与操作">
              <div class="resource-tabs" role="tablist" aria-label="资源审核状态">
                <button v-for="view in approvalViews" :key="view.key" class="resource-tab" :class="{ active: approvalStatus === view.key }"
                  type="button" role="tab" :aria-selected="approvalStatus === view.key" @click="switchApprovalView(view.key)">
                  <span>{{ view.label }}</span><span class="resource-tab-count" :class="{ pending: view.key === 'pending' }">{{ approvalCounts[view.key] }}</span>
                </button>
              </div>
              <div class="resource-view-hint">
                <ConsoleIcon :name="approvalStatus === 'pending' ? 'clock' : approvalStatus === 'rejected' ? 'close' : 'database'" :size="15" />
                <span>{{ viewDescription }}</span>
              </div>
              <form class="query-toolbar" @submit.prevent="loadResources"><label class="query-input">
                  <ConsoleIcon name="search" :size="16" /><input v-model.trim="query" type="search"
                    placeholder="按名称、描述或标签查询" />
                </label><select v-model="cloudType" class="query-select" aria-label="网盘类型">
                  <option value="">全部网盘</option>
                  <option v-for="item in cloudTypes" :key="item" :value="item">{{ cloudLabel(item) }}</option>
                </select>
                <div class="query-actions"><button class="button primary" type="submit">
                    <ConsoleIcon name="search" :size="14" />查询
                  </button><button class="button secondary" type="button" @click="resetQuery">重置</button><button
                    class="button secondary" type="button" :disabled="!selected.length || busy"
                    @click="checkSelected">批量检测<span v-if="selected.length" class="action-count">{{ selected.length
                    }}</span></button><button
                    class="button danger-button" type="button" :disabled="!selected.length || busy"
                    @click="deleteSelected"><ConsoleIcon name="trash" :size="14" />批量删除<span v-if="selected.length" class="action-count">{{ selected.length
                    }}</span></button><button class="button secondary" type="button" :disabled="!canEnable || busy"
                    v-if="approvalStatus === 'approved'" @click="setEnabled(selected, true)">批量启用</button><button
                    v-if="approvalStatus === 'approved'" class="button danger-button" type="button" :disabled="!canDisable || busy" @click="setEnabled(selected, false)"><ConsoleIcon name="stop" :size="14" />批量停用</button><button
                    class="button primary" type="button" @click="openCreate">
                    <ConsoleIcon name="plus" :size="14" />新增资源
                  </button><button v-if="approvalStatus === 'pending'" class="button primary" type="button" :disabled="!selected.length || busy" @click="reviewSelected('approved')">批量通过</button><button v-if="approvalStatus === 'pending'" class="button danger-button" type="button" :disabled="!selected.length || busy" @click="reviewSelected('rejected')">批量拒绝</button></div>
              </form>
              <div class="query-meta">已选 {{ selected.length }} 项 · {{ viewLabel }} {{ total }} 条</div>
            </section>
            <section class="sources-panel directory-panel table-panel" aria-label="资源列表">
              <div class="table-scroll">
                <table class="source-table resource-table admin-data-table">
                  <thead>
                    <tr>
                      <th class="checkbox-column"><input type="checkbox" :checked="allSelected"
                          :indeterminate="someSelected" aria-label="选择当前页全部资源" @change="toggleAll" /></th>
                      <th class="serial-column">序号</th>
                      <th>名称</th>
                      <th>网盘类型</th>
                      <th>标签</th>
                      <th>链接</th>
                      <th>资源时间</th>
                      <th>状态</th>
                      <th>审核状态</th>
                      <th>检测状态</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(item, index) in resources" :key="item.id"
                      :class="{ 'selected-row': selected.includes(item.id) }">
                      <td class="checkbox-column"><input type="checkbox" :checked="selected.includes(item.id)"
                          :aria-label="`选择 ${item.name}`" @change="toggle(item.id)" /></td>
                      <td class="serial-column">{{ (page - 1) * pageSize + index + 1 }}</td>
                      <td><strong>{{ item.name }}</strong><ResourceDescription variant="admin"
                          :text="item.description || '无描述'" /></td>
                      <td><span v-for="type in item.cloud_types" :key="type" class="resource-chip">{{ cloudLabel(type)
                      }}</span></td>
                      <td><span v-for="tag in (item.tags || []).slice(0, 3)" :key="tag" class="resource-chip muted">{{
                        tag }}</span><span v-if="(item.tags || []).length > 3" class="table-muted">+{{
                            item.tags!.length - 3 }}</span></td>
                      <td class="resource-links-cell">
                        <div v-for="(link, linkIndex) in item.links" :key="`${link.url}-${linkIndex}`" class="resource-link-item">
                          <a class="resource-link" :href="link.url" target="_blank" rel="noopener noreferrer nofollow" :title="link.url">
                            <span class="resource-link-type">{{ cloudLabel(link.type) }}</span>
                            <span class="resource-link-url">{{ link.url }}</span>
                          </a>
                          <span v-if="link.password" class="resource-link-password">提取码 {{ link.password }}</span>
                        </div>
                      </td>
                      <td>{{ item.datetime || "—" }}</td>
                      <td><span class="resource-status" :class="{ off: item.enabled === false }">{{ item.enabled === false ?
                        "已停用" : "已启用" }}</span></td>
                      <td><span class="resource-status" :class="approvalClass(item.approvalStatus)">{{ approvalLabel(item.approvalStatus) }}</span></td>
                      <td><span class="resource-check-status" :class="`check-${item.checkStatus || 'unchecked'}`"
                          :title="item.checkMessage || ''">{{ checkStatusLabel(item.checkStatus) }}</span><small
                          v-if="item.checkMessage" class="check-message">{{ item.checkMessage }}</small></td>
                      <td class="action-column">
                        <div class="row-actions"><button class="icon-button" type="button"
                            :aria-label="`编辑 ${item.name}`" title="编辑" @click="openEdit(item)">
                            <ConsoleIcon name="edit" :size="15" />
                          </button><button v-if="item.approvalStatus === 'pending'" class="icon-button" type="button" :disabled="busy" aria-label="通过审核" title="通过审核" @click="review([item.id], 'approved')"><ConsoleIcon name="check" :size="14" /></button><button v-if="item.approvalStatus === 'pending'" class="icon-button danger-icon" type="button" :disabled="busy" aria-label="拒绝审核" title="拒绝审核" @click="review([item.id], 'rejected')"><ConsoleIcon name="close" :size="14" /></button><button class="icon-button" type="button" :disabled="busy"
                            :aria-label="`检测 ${item.name}`" title="检测此资源的链接状态" @click="checkOne(item)">
                            <ConsoleIcon name="refresh" :size="14" />
                          </button><button v-if="approvalStatus === 'approved'"
                            class="icon-button" :class="{ 'danger-icon': item.enabled !== false }" type="button" :disabled="busy"
                            :title="item.enabled === false ? '重新出现在搜索结果里' : '从搜索结果里隐藏，数据保留'"
                            :aria-label="`${item.enabled === false ? '启用' : '停用'} ${item.name}`"
                            @click="setEnabled([item.id], item.enabled === false)">
                            <ConsoleIcon :name="item.enabled === false ? 'check' : 'stop'" :size="13" />
                          </button><button class="icon-button danger-icon" type="button"
                            :aria-label="`删除 ${item.name}`" title="删除" @click="remove(item)">
                            <ConsoleIcon name="trash" :size="15" />
                          </button></div>
                      </td>
                    </tr>
                    <tr v-if="!loading && !resources.length">
                      <td colspan="11" class="empty-cell">{{ query || cloudType
                        ? "没有匹配的资源。此处与前台搜索使用同一套分词规则（会忽略 1080p / 4K 等噪声词），关键词至少需要 2 个字符。"
                        : emptyLabel }}
                      </td>
                    </tr>
                    <tr v-if="loading">
                      <td colspan="11" class="empty-cell">正在加载资源…</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <AdminPagination :page="page" :total-pages="pageCount" :page-size="pageSize" :total="total"
                @change="goPage" @update:page-size="changePageSize" />
            </section>
          </section>
        </main>
      </div>
    </template>
    <div v-if="drawerOpen" class="admin-modal-backdrop" @click.self="closeDrawer">
      <section class="admin-modal resource-drawer" role="dialog" aria-modal="true" aria-labelledby="resource-title">
        <div class="modal-header">
          <div><span class="eyebrow">RESOURCE LIBRARY</span>
            <h2 id="resource-title">{{ editing ? "编辑资源" : "新增资源" }}</h2>
          </div><button class="modal-close" type="button" @click="closeDrawer">×</button>
        </div>
        <form class="resource-form" @submit.prevent="save"><label>资源名称<input v-model.trim="form.name" required
              maxlength="200" placeholder="例如：流浪地球 2" /></label><label>描述<textarea v-model.trim="form.description"
              rows="3" maxlength="5000" placeholder="可选"></textarea></label>
          <div class="form-two-col"><label>资源时间<input v-model.trim="form.datetime" maxlength="80"
                placeholder="例如：2026-09-17" /></label><label>标签<input v-model="tagText"
                placeholder="多个标签用逗号分隔" /></label>
          </div>
          <div class="resource-links-title"><strong>网盘链接</strong><button class="button secondary" type="button"
              @click="addLink">添加链接</button></div>
          <div v-for="(link, index) in form.links" :key="index" class="link-editor"><select v-model="link.type"
              aria-label="网盘类型">
              <option v-for="item in cloudTypes" :key="item" :value="item">{{ cloudLabel(item) }}</option>
            </select><input v-model.trim="link.url" required placeholder="分享链接" /><input v-model.trim="link.password"
              placeholder="提取码（可选）" /><button class="icon-button" type="button" :disabled="form.links.length === 1"
              @click="removeLink(index)">×</button></div><label>图片地址<input v-model="imageText"
              placeholder="多个图片 URL 用逗号分隔" /></label>
          <p v-if="formError" class="form-error">{{ formError }}</p>
          <div class="modal-actions"><button class="button secondary" type="button"
              @click="closeDrawer">取消</button><button class="button primary" type="submit" :disabled="busy">{{ busy ?
                "保存中…" : "保存资源" }}</button></div>
        </form>
      </section>
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import AdminAccessGate from "./AdminAccessGate.vue";
import AdminPagination from "./AdminPagination.vue";
import ConsoleIcon from "../sources/ConsoleIcon.vue";
import type { CloudType, Link, SearchResult } from "../../server/core/types/models";
import { CLOUD_TYPE_SHORT_LABELS } from "~/shared/cloudTypes";

type AdminResource = SearchResult & { createdAt?: number; updatedAt?: number; enabled?: boolean; approvalStatus?: "pending" | "approved" | "rejected"; checkStatus?: "unchecked" | "checking" | "valid" | "invalid" | "unknown"; checkMessage?: string | null; checkedAt?: number | null };
type ApprovalStatus = NonNullable<AdminResource["approvalStatus"]>;
type ApprovalCounts = Record<ApprovalStatus, number>;
const approvalViews: Array<{ key: ApprovalStatus; label: string }> = [
  { key: "approved", label: "资源库" },
  { key: "pending", label: "待审核" },
  { key: "rejected", label: "已拒绝" },
];
const cloudTypes = ref<CloudType[]>([]); const resources = ref<AdminResource[]>([]); const query = ref(""); const cloudType = ref(""); const approvalStatus = ref<ApprovalStatus>("approved"); const approvalCounts = ref<ApprovalCounts>({ approved: 0, pending: 0, rejected: 0 }); const page = ref(1); const pageSize = ref(20); const total = ref(0); const selected = ref<string[]>([]); const loading = ref(false); const busy = ref(false); const notice = ref(""); const noticeError = ref(false); const checking = ref(true); const authenticated = ref(false); const locked = ref(true); const authError = ref(""); const drawerOpen = ref(false); const editing = ref(false); const formError = ref(""); const tagText = ref(""); const imageText = ref("");
const form = ref<{ id?: string; name: string; description: string; datetime: string; links: Array<{ type: CloudType; url: string; password: string }> }>({ name: "", description: "", datetime: "", links: [{ type: "baidu", url: "", password: "" }] });
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value))); const currentKeys = computed(() => resources.value.map((item) => item.id)); const allSelected = computed(() => currentKeys.value.length > 0 && currentKeys.value.every((id) => selected.value.includes(id))); const someSelected = computed(() => selected.value.some((id) => currentKeys.value.includes(id)) && !allSelected.value);
const activeView = computed(() => approvalViews.find((view) => view.key === approvalStatus.value) || approvalViews[0]);
const viewLabel = computed(() => activeView.value.label);
const viewDescription = computed(() => approvalStatus.value === "pending" ? "新提交的资源会先进入这里；审核通过后才会进入资源库并参与前台搜索。" : approvalStatus.value === "rejected" ? "已拒绝的提交会保留在这里，方便复核或清理。" : "资源库只展示已通过审核的资源；停用只会隐藏搜索结果，不会删除数据。");
const emptyLabel = computed(() => approvalStatus.value === "pending" ? "当前没有待审核资源。" : approvalStatus.value === "rejected" ? "当前没有已拒绝的资源。" : "还没有已入库资源，点击右上角新增资源。");
// Selection is trimmed to the current page on every load, so the batch enable and
// disable buttons can tell whether they would actually change anything.
const selectedItems = computed(() => resources.value.filter((item) => selected.value.includes(item.id))); const canEnable = computed(() => selectedItems.value.some((item) => item.enabled === false)); const canDisable = computed(() => selectedItems.value.some((item) => item.enabled !== false));
function cloudLabel(type: string) { return CLOUD_TYPE_SHORT_LABELS[type as CloudType] || type; }
function checkStatusLabel(status?: AdminResource["checkStatus"]) { return status === "valid" ? "正常" : status === "invalid" ? "已失效" : status === "unknown" ? "待确认" : status === "checking" ? "检测中" : "未检测"; }
function approvalLabel(status?: AdminResource["approvalStatus"]) { return status === "pending" ? "待审核" : status === "rejected" ? "已拒绝" : "已通过"; }
function approvalClass(status?: AdminResource["approvalStatus"]) { return status === "pending" ? "approval-pending" : status === "rejected" ? "approval-rejected" : "approval-approved"; }
function statusOf(error: any) { return error?.statusCode || error?.response?.status || error?.status; } function apiError(error: any) { const status = statusOf(error); return status === 401 ? "请先登录管理员账号。" : status === 403 ? "当前账号没有管理员权限。" : error?.data?.statusMessage || error?.message || "后台请求失败。"; } function show(message: string, error = false) { notice.value = message; noticeError.value = error; }
async function checkStatus() { checking.value = true; authError.value = ""; try { const status = await $fetch<any>("/api/account/session", { credentials: "include", cache: "no-store", retry: 0 }); authenticated.value = !!status.authenticated; locked.value = !(authenticated.value && status.user?.role === "admin"); if (!locked.value) await loadResources(); } catch (e: any) { locked.value = true; authError.value = apiError(e); } finally { checking.value = false; } }
async function lock() { await $fetch("/api/account/logout", { method: "POST", credentials: "include", retry: 0 }).catch(() => { }); await navigateTo("/"); }
async function loadResources() { loading.value = true; try { const result = await $fetch<any>("/api/admin/resources", { query: { q: query.value || undefined, cloudType: cloudType.value || undefined, approvalStatus: approvalStatus.value, page: page.value, pageSize: pageSize.value }, cache: "no-store" }); const data = result?.data ?? result; resources.value = data.items || []; total.value = Number(data.total || 0); cloudTypes.value = data.cloudTypes || cloudTypes.value; if (data.approvalCounts) approvalCounts.value = { ...approvalCounts.value, ...data.approvalCounts }; selected.value = selected.value.filter((id) => currentKeys.value.includes(id)); } catch (e: any) { show(apiError(e), true); if (statusOf(e) === 401) locked.value = true; } finally { loading.value = false; } }
function switchApprovalView(next: ApprovalStatus) { if (approvalStatus.value === next || busy.value) return; approvalStatus.value = next; page.value = 1; selected.value = []; void loadResources(); }
function resetQuery() { query.value = ""; cloudType.value = ""; page.value = 1; void loadResources(); } function goPage(next: number) { if (next >= 1 && next <= pageCount.value && next !== page.value) { page.value = next; void loadResources(); } } function changePageSize(size: number) { pageSize.value = size; page.value = 1; void loadResources(); } function toggle(id: string) { selected.value = selected.value.includes(id) ? selected.value.filter((item) => item !== id) : [...selected.value, id]; } function toggleAll(event: Event) { const checked = (event.target as HTMLInputElement).checked; selected.value = checked ? [...new Set([...selected.value, ...currentKeys.value])] : selected.value.filter((id) => !currentKeys.value.includes(id)); }
function blank() { return { name: "", description: "", datetime: "", links: [{ type: (cloudTypes.value[0] || "baidu") as CloudType, url: "", password: "" }] }; } function openCreate() { editing.value = false; formError.value = ""; form.value = blank(); tagText.value = ""; imageText.value = ""; drawerOpen.value = true; } function openEdit(item: AdminResource) { editing.value = true; formError.value = ""; form.value = { id: item.id, name: item.name, description: item.description || "", datetime: item.datetime || "", links: item.links.map((link: Link) => ({ type: link.type, url: link.url, password: link.password || "" })) }; tagText.value = (item.tags || []).join(", "); imageText.value = (item.images || []).join(", "); drawerOpen.value = true; } function closeDrawer() { if (!busy.value) drawerOpen.value = false; } function addLink() { form.value.links.push({ type: (cloudTypes.value[0] || "baidu") as CloudType, url: "", password: "" }); } function removeLink(index: number) { if (form.value.links.length > 1) form.value.links.splice(index, 1); }
async function save() { if (busy.value) return; formError.value = ""; busy.value = true; const isCreating = !editing.value; const body = { name: form.value.name, description: form.value.description || null, datetime: form.value.datetime || null, links: form.value.links, tags: tagText.value.split(",").map((v) => v.trim()).filter(Boolean), images: imageText.value.split(",").map((v) => v.trim()).filter(Boolean) }; try { await $fetch(isCreating ? "/api/admin/resources" : `/api/admin/resources/${encodeURIComponent(form.value.id!)}`, { method: isCreating ? "POST" : "PUT", body }); drawerOpen.value = false; if (isCreating) { approvalStatus.value = "pending"; page.value = 1; selected.value = []; } show(isCreating ? "资源已提交审核，请通过后再进入资源库。" : "资源已更新。"); await loadResources(); } catch (e: any) { formError.value = apiError(e); } finally { busy.value = false; } }
async function remove(item: AdminResource) { if (busy.value || !window.confirm(`确定删除「${item.name}」吗？`)) return; busy.value = true; try { await $fetch(`/api/admin/resources/${encodeURIComponent(item.id)}`, { method: "DELETE" }); selected.value = selected.value.filter((id) => id !== item.id); page.value = Math.min(page.value, Math.max(1, Math.ceil((total.value - 1) / pageSize.value))); show("资源已删除。"); await loadResources(); } catch (e: any) { show(apiError(e), true); } finally { busy.value = false; } }
async function deleteSelected() { if (!selected.value.length || !window.confirm(`确定删除选中的 ${selected.value.length} 条资源吗？`)) return; busy.value = true; try { await $fetch("/api/admin/resources/batch-delete", { method: "POST", body: { ids: selected.value } }); const count = selected.value.length; selected.value = []; page.value = Math.min(page.value, Math.max(1, Math.ceil((total.value - count) / pageSize.value))); show(`已删除 ${count} 条资源。`); await loadResources(); } catch (e: any) { show(apiError(e), true); } finally { busy.value = false; } }
async function setEnabled(ids: string[], enabled: boolean) { const targets = [...new Set(ids)].filter(Boolean); if (!targets.length || busy.value) return; if (targets.length > 1 && !window.confirm(`确定${enabled ? "启用" : "停用"}选中的 ${targets.length} 条资源吗？`)) return; busy.value = true; try { const result = await $fetch<any>("/api/admin/resources/enabled", { method: "POST", body: { ids: targets, enabled } }); const count = Number(result?.data?.count ?? 0); show(count ? `已${enabled ? "启用" : "停用"} ${count} 条资源。` : "所选资源已经是该状态，未做改动。"); await loadResources(); } catch (e: any) { show(apiError(e), true); } finally { busy.value = false; } }
async function review(ids: string[], status: "approved" | "rejected") { const targets = [...new Set(ids)].filter(Boolean); if (!targets.length || busy.value) return; if (targets.length > 1 && !window.confirm(`确定${status === "approved" ? "通过" : "拒绝"}选中的 ${targets.length} 条资源吗？`)) return; busy.value = true; try { const result = await $fetch<any>("/api/admin/resources/approval", { method: "POST", body: { ids: targets, status } }); const count = Number(result?.data?.count ?? 0); selected.value = selected.value.filter((id) => !targets.includes(id)); show(count ? `已${status === "approved" ? "通过" : "拒绝"} ${count} 条资源。` : "没有待审核资源发生变化。"); await loadResources(); } catch (e: any) { show(apiError(e), true); } finally { busy.value = false; } }
function reviewSelected(status: "approved" | "rejected") { void review(selected.value, status); }
async function checkResources(ids: string[], label: string) { const targets = [...new Set(ids)].filter(Boolean); if (!targets.length || busy.value) return; busy.value = true; show(`正在检测 ${label}，请稍候…`); try { const result = await $fetch<any>("/api/admin/resources/check", { method: "POST", body: { ids: targets } }); const data = result?.data ?? {}; show(`检测完成：${Number(data.valid || 0)} 条正常，${Number(data.invalid || 0)} 条失效，${Number(data.unknown || 0)} 条待确认。`); await loadResources(); } catch (e: any) { show(apiError(e), true); } finally { busy.value = false; } }
function checkSelected() { void checkResources(selected.value, `${selected.value.length} 条资源`); }
function checkOne(item: AdminResource) { void checkResources([item.id], `「${item.name}」`); }
onMounted(checkStatus);
</script>
<style src="../../assets/source-console.css"></style>
<style scoped>
.feature-content {
  width: 100%;
  margin: 0;
  padding: 0
}

.feature-notice {
  margin: 0 0 14px;
  padding: 10px 13px;
  border: 1px solid #dbeafe;
  border-radius: 8px;
  color: #1d4ed8;
  background: #eff6ff;
  font-size: 12px
}

.feature-notice.error {
  border-color: #fecaca;
  color: #b91c1c;
  background: #fef2f2
}

.query-panel {
  position: sticky;
  top: calc(var(--console-topbar-height) + 10px);
  z-index: 12;
  margin-bottom: 16px;
  padding: 0;
  border: 1px solid #dfe7f1;
  border-radius: 14px;
  background: rgba(255, 255, 255, .98);
  box-shadow: 0 10px 30px rgba(40, 62, 92, .06);
  overflow: visible;
  backdrop-filter: blur(12px)
}

.resource-tabs {
  display: flex;
  align-items: stretch;
  gap: 4px;
  padding: 10px 16px 0;
  border-bottom: 1px solid #edf1f6;
  background: #fff
}

.resource-tab {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 42px;
  padding: 0 12px;
  border: 0;
  border-bottom: 2px solid transparent;
  color: #64748b;
  background: transparent;
  font: inherit;
  font-size: 12px;
  font-weight: 650;
  cursor: pointer;
  transition: color .18s ease, border-color .18s ease, background-color .18s ease
}

.resource-tab:hover,
.resource-tab.active {
  color: #2563eb;
  border-bottom-color: #2563eb
}

.resource-tab:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: -2px
}

.resource-tab.active {
  background: #f8fbff
}

.resource-tab-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 999px;
  color: #64748b;
  background: #f1f5f9;
  font-size: 10px;
  font-variant-numeric: tabular-nums
}

.resource-tab-count.pending {
  color: #9a6700;
  background: #fff4ce
}

.resource-view-hint {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 10px 16px;
  color: #64748b;
  background: #fbfcfe;
  font-size: 11px;
  line-height: 1.5
}

.resource-view-hint :deep(svg) {
  flex: 0 0 auto;
  margin-top: 1px;
  color: #2563eb
}

.query-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 14px 16px;
  border-bottom: 1px solid #edf1f6;
  background: #fbfcfe
}

.query-input {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 260px;
  min-width: 220px;
  height: 44px;
  padding: 0 13px;
  border: 1px solid #dce5f0;
  border-radius: 10px;
  color: #7b8794;
  background: #fff
}

.query-input:focus-within {
  border-color: #60a5fa;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, .1)
}

.query-input input {
  min-width: 0;
  flex: 1;
  border: 0;
  outline: 0;
  color: #111827;
  background: transparent;
  font: inherit;
  font-size: 12px
}

.query-select {
  width: 120px;
  flex: 0 0 120px;
  height: 44px;
  padding: 0 25px 0 12px;
  border: 1px solid #dce5f0;
  border-radius: 10px;
  color: #475569;
  background: #fff;
  font: inherit;
  font-size: 12px
}

.query-actions {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap
}

.query-actions .button {
  min-height: 44px;
  border-radius: 10px
}

.action-count {
  min-width: 17px;
  padding: 1px 5px;
  border-radius: 99px;
  color: currentColor;
  background: rgba(255, 255, 255, .35);
  font-size: 10px;
  text-align: center
}

.query-meta {
  display: flex;
  align-items: center;
  min-height: 39px;
  margin: 0;
  padding: 0 16px;
  border-bottom: 1px solid #edf1f6;
  background: #fbfcfe;
  color: #8591a2;
  font-size: 10px
}

.table-panel {
  overflow: hidden;
  border: 1px solid #dfe7f1;
  border-radius: 14px;
  background: #fff;
  box-shadow: 0 10px 30px rgba(40, 62, 92, .06)
}

.table-scroll {
  max-height: min(680px, calc(100vh - 300px));
  overflow: auto
}

.table-scroll table {
  width: 100%;
  min-width: 1240px;
  table-layout: fixed
}

.table-scroll thead th {
  position: sticky;
  top: 0;
  z-index: 3
}

.table-scroll th,
.table-scroll td {
  vertical-align: middle
}

.table-scroll td {
  color: #334155
}

.admin-data-table thead {
  box-shadow: inset 0 1px #e3eaf2, inset 0 -1px #dfe7f0
}

.admin-data-table th {
  height: 42px;
  padding: 0 12px;
  background: #f3f6fa;
  color: #526176;
  font-size: 11px;
  font-weight: 700
}

.admin-data-table td {
  height: 72px;
  padding: 12px;
  border-bottom: 1px solid #e9eef4;
  background: #fff;
  font-size: 11px
}

.admin-data-table tbody tr:nth-child(even) td {
  background: #fcfdff
}

.admin-data-table tbody tr:hover td {
  background: #f5f8fc
}

.admin-data-table tbody tr.selected-row td {
  background: #eff6ff
}

.table-scroll input[type=checkbox] {
  width: 15px;
  height: 15px;
  accent-color: #2563eb
}

.checkbox-column {
  width: 42px;
  padding-right: 3px !important;
  padding-left: 16px !important;
  text-align: center !important
}

.serial-column {
  width: 58px;
  text-align: center !important
}

.table-panel :deep(.pagination) {
  min-height: 42px;
  padding: 0 20px;
  background: #fbfcfe
}

.admin-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(15, 23, 42, .42);
  backdrop-filter: blur(3px)
}

.admin-modal {
  width: min(460px, 100%);
  padding: 24px;
  border: 1px solid #e5e7eb;
  border-radius: 16px;
  background: #fff;
  box-shadow: 0 24px 70px rgba(15, 23, 42, .22)
}

.resource-chip {
  display: inline-block;
  margin: 2px 4px 2px 0;
  padding: 2px 6px;
  border-radius: 4px;
  color: #2563eb;
  background: #eff6ff;
  font-size: 10px
}

.resource-chip.muted {
  color: #64748b;
  background: #f1f5f9
}

.resource-links-cell {
  min-width: 230px;
  max-width: 340px;
  white-space: normal !important
}

.resource-link-item + .resource-link-item {
  margin-top: 7px
  }

.resource-link {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 6px;
  color: #2563eb;
  text-decoration: none
}

.resource-link:hover {
  color: #1d4ed8;
  text-decoration: underline
}

.resource-link-type {
  flex: 0 0 auto;
  padding: 2px 5px;
  border-radius: 4px;
  color: #2563eb;
  background: #eff6ff;
  font-size: 10px
}

.resource-link-url {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap
}

.resource-link-password {
  display: block;
  margin-top: 3px;
  color: #64748b;
  font-size: 10px
}

.table-muted {
  color: #94a3b8;
  font-size: 11px
}

.resource-status {
  display: inline-block;
  padding: 2px 7px;
  border-radius: 4px;
  color: #0f6e56;
  background: #e1f5ee;
  font-size: 10px;
  white-space: nowrap
}

.resource-status.off {
  color: #64748b;
  background: #f1f5f9
}

.resource-status.approval-pending {
  color: #9a6700;
  background: #fff4ce
}

.resource-status.approval-rejected {
  color: #b42318;
  background: #fee4e2
}

.resource-status.approval-approved {
  color: #0f6e56;
  background: #e1f5ee
}

.resource-check-status {
  display: inline-block;
  padding: 2px 7px;
  border-radius: 4px;
  color: #64748b;
  background: #f1f5f9;
  font-size: 10px;
  white-space: nowrap
}

.resource-check-status.check-valid {
  color: #0f6e56;
  background: #e1f5ee
}

.resource-check-status.check-invalid {
  color: #b42318;
  background: #fee4e2
}

.resource-check-status.check-unknown,
.resource-check-status.check-checking {
  color: #9a6700;
  background: #fff4ce
}

.check-message {
  display: block;
  max-width: 160px;
  margin-top: 4px;
  overflow: hidden;
  color: #94a3b8;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap
}

/* The shared `.row-actions` rule is a wrapping flex row, which stacked the three
   row buttons on top of each other once this table gained more columns. Match
   the source directory instead: one compact row, left aligned, never wrapping. */
.resource-table .row-actions {
  flex-wrap: nowrap;
  justify-content: flex-start;
  gap: 7px
}

.resource-table .row-actions .button.tiny {
  min-height: 30px;
  padding: 5px 8px
}

.resource-table .row-actions .icon-button {
  width: 32px;
  min-width: 32px;
  min-height: 32px
}

.resource-table td.action-column {
  padding: 8px 9px
}

.resource-drawer {
  width: min(680px, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  overflow: auto
}

.modal-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  padding-bottom: 20px;
  margin-bottom: 20px;
  border-bottom: 1px solid #eef2f7
}

.modal-header h2 {
  margin: 0 0 6px;
  color: #111827;
  font-size: 20px
}

.eyebrow {
  display: block;
  margin: 0 0 7px;
  color: #2563eb;
  font: 700 10px ui-monospace, SFMono-Regular, Consolas, monospace;
  letter-spacing: 1.6px
}

.modal-close {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  color: #64748b;
  background: transparent;
  font-size: 22px;
  cursor: pointer
}

.modal-close:hover {
  color: #111827;
  background: #f1f5f9
}

.resource-form {
  display: grid;
  gap: 14px
}

.resource-form label {
  display: grid;
  gap: 6px;
  color: #475569;
  font-size: 12px;
  font-weight: 600
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
  font-weight: 400
}

.form-two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px
}

.resource-links-title {
  display: flex;
  align-items: center;
  justify-content: space-between
}

.link-editor {
  display: grid;
  grid-template-columns: 110px 1fr 120px 32px;
  gap: 7px
}

.icon-button {
  border: 1px solid #e5e7eb;
  border-radius: 7px;
  background: #fff;
  color: #dc2626;
  font-size: 18px
}

.form-error {
  color: #dc2626;
  font-size: 12px
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid #e5e7eb
}

@media(min-width:821px) {
  .query-toolbar {
    flex-wrap: nowrap
  }

  .query-actions {
    flex-wrap: wrap;
    justify-content: flex-end
  }

  .query-input {
    min-width: 180px
  }

  .query-actions .button {
    flex: 0 0 auto
  }
}

@media(max-width:820px) {
  .resource-tabs {
    overflow-x: auto
  }

  .resource-tab {
    flex: 0 0 auto
  }

  .query-toolbar {
    align-items: stretch
  }

  .query-input {
    min-width: 100%
  }

  .query-select {
    width: 100%;
    flex: 1 1 100%
  }

  .query-actions {
    width: 100%
  }

  .query-actions .button {
    flex: 1 1 auto
  }
}

@media(max-width:700px) {
  .query-toolbar {
    padding: 12px 16px
  }

  .table-scroll {
    max-height: min(58vh, 560px)
  }

  .query-panel {
    top: calc(var(--console-topbar-height) + 6px)
  }

  .query-actions .button {
    flex: 1 1 calc(50% - 7px)
  }

  .form-two-col {
    grid-template-columns: 1fr
  }

  .link-editor {
    grid-template-columns: 1fr
  }

  .resource-drawer {
    width: calc(100vw - 20px)
  }
}

.resource-table th:nth-child(1),
.resource-table td:nth-child(1) {
  width: 3%
}

.resource-table th:nth-child(2),
.resource-table td:nth-child(2) {
  width: 4%
}

.resource-table th:nth-child(3),
.resource-table td:nth-child(3) {
  width: 16%;
  white-space: normal;
  overflow: hidden
}

.resource-table th:nth-child(4),
.resource-table td:nth-child(4) {
  width: 7%;
  white-space: normal
}

.resource-table th:nth-child(5),
.resource-table td:nth-child(5) {
  width: 7%;
  white-space: normal
}

.resource-table th:nth-child(6),
.resource-table td:nth-child(6) {
  width: 20%;
  white-space: normal
}

.resource-table th:nth-child(7),
.resource-table td:nth-child(7) {
  width: 7%;
  white-space: nowrap
}

.resource-table th:nth-child(8),
.resource-table td:nth-child(8) {
  width: 6%;
  white-space: nowrap
}

.resource-table th:nth-child(9),
.resource-table td:nth-child(9) {
  width: 7%;
  white-space: nowrap
}

.resource-table th:nth-child(10),
.resource-table td:nth-child(10) {
  width: 7%;
  white-space: nowrap
}

.resource-table th:nth-child(11),
.resource-table td:nth-child(11) {
  width: 16%;
  white-space: nowrap
}

.resource-table td:nth-child(3)>strong {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap
}
</style>
