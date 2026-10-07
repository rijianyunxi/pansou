<template>
  <section :class="['result-card', { 'result-card--flat': !showHeader }]">
    <header v-if="showHeader" class="card-header">
      <div class="header-mark" :style="{ '--mark-color': color }" aria-hidden="true">{{ icon }}</div>
      <div class="header-info">
        <h2 class="platform-title">{{ title }}</h2>
        <span class="resource-count">{{ items.length }} 个分享链接</span>
      </div>
      <button v-if="canToggleCollapse" class="expand-btn" type="button" @click="emit('toggle')">
        {{ expanded ? '收起' : '展开' }}
      </button>
    </header>

    <ul class="resource-list">
      <li v-for="resource in visibleItems" :key="resource.id" class="resource-item">
        <div class="resource-art" aria-hidden="true"><svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor"><path d="M3 5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Z"/></svg></div>
        <div class="resource-heading">
          <div class="resource-heading-main">
            <h3 class="resource-title"><template v-for="(part, index) in titleParts(resource.name)" :key="index"><mark v-if="part.match">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></h3>
            <ResourceDescription :text="resource.description" />
          </div>
        </div>

        <div class="resource-links" aria-label="资源链接">
          <div v-for="link in resource.links" :key="link.linkRef" class="link-row">
            <div class="link-main" aria-live="polite">
              <span class="link-provider" :data-provider="link.type">{{ platformLabel(link.type) }}</span>
              <time v-if="resource.datetime" class="resource-date" :datetime="resource.datetime">{{ resource.datetime }}</time>
              <button v-if="resolved[link.linkRef]?.password" class="password-badge" type="button" :disabled="!!loading[link.linkRef] || !!copyingPassword" title="复制提取码" @click="copyPassword(link.linkRef)">提取码 {{ resolved[link.linkRef]?.password }} · 复制</button>
            </div>
            <div class="link-actions">
              <button class="open-btn" type="button" :disabled="!!loading[link.linkRef]" :aria-busy="loading[link.linkRef] === 'open'" title="获取链接后打开" @click="act('open', resource, link)">{{ loading[link.linkRef] === 'open' ? '正在获取…' : '打开资源 ↗' }}</button>
              <button class="copy-btn" type="button" :disabled="!!loading[link.linkRef]" :aria-busy="loading[link.linkRef] === 'copy'" title="获取并复制链接" @click="act('copy', resource, link)">{{ loading[link.linkRef] === 'copy' ? '正在复制…' : copiedKey === link.linkRef ? '已复制' : '复制链接' }}</button>
            </div>

          </div>
        </div>
      </li>
    </ul>

    <footer v-if="!expanded && items.length > initialVisible" class="card-footer">
      <button class="load-more-btn" type="button" @click="emit('toggle')">
        显示更多 {{ items.length - initialVisible }} 个资源
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M12 5v14M5 12l7 7 7-7"></path>
        </svg>
      </button>
    </footer>
  </section>
  <LinkActionDialog :state="dialog" :now="now" @close="closeDialog" @retry="retryDialog" @copy="copyReady" @open="openReady" />
</template>

<script setup lang="ts">
import { computed, ref, reactive, inject, onBeforeUnmount } from "vue";
import { resolveLink, usable } from '~/utils/linkResolution';
import { executeLinkAction, invalidLink, type LinkAction } from '~/utils/linkActions';
import LinkActionDialog, { type LinkDialogState } from "./LinkActionDialog.vue";
import ResourceDescription from "./ResourceDescription.vue";
import type { SearchLink, ResolvedLink } from "~/shared/apiModels";
import type { DisplaySearchResult } from "~/utils/resultDisplay";
import type { ShowToast } from "~/composables/useToast";

const props = withDefaults(defineProps<{
  title: string;
  keyword?: string;
  color: string;
  icon: string;
  items: DisplaySearchResult[];
  expanded: boolean;
  initialVisible: number;
  canToggleCollapse?: boolean;
  showHeader?: boolean;
  platformLabel?: (type: string) => string;
}>(), {
  keyword: "",
  canToggleCollapse: false,
  showHeader: true,
  platformLabel: (type: string) => type || "其他",
});

const emit = defineEmits<{
  (event: "toggle"): void;
}>();

function titleParts(title: string) {
  const keyword = props.keyword.trim();
  if (!keyword) return [{ text: title, match: false }];
  const parts: { text: string; match: boolean }[] = [];
  let cursor = 0;
  let index = title.toLowerCase().indexOf(keyword.toLowerCase());
  while (index !== -1) {
    if (index > cursor) parts.push({ text: title.slice(cursor, index), match: false });
    parts.push({ text: title.slice(index, index + keyword.length), match: true });
    cursor = index + keyword.length;
    index = title.toLowerCase().indexOf(keyword.toLowerCase(), cursor);
  }
  if (cursor < title.length) parts.push({ text: title.slice(cursor), match: false });
  return parts;
}

const copiedKey = ref("");
const copyingPassword = ref("");
const resolved = reactive<Record<string, ResolvedLink>>({});
const loading = reactive<Record<string, LinkAction | undefined>>({});
const now = ref(Date.now());
const dialog = ref<LinkDialogState | null>(null);
let active: { resource: DisplaySearchResult; link: SearchLink; action: LinkAction; controller: AbortController; value?: ResolvedLink } | undefined;
const keys = reactive<Record<string, string>>({});
const controllers = new Set<AbortController>();
const showToast = inject<ShowToast>('showToast', () => () => {});
let gone = false;
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
const timer = setInterval(() => {
  now.value = Date.now();
  for (const [ref, value] of Object.entries(resolved)) {
    if ([value.deliveryExpiresAt, value.shareExpiresAt].some(t => t && Date.parse(t) <= Date.now())) { delete resolved[ref]; delete keys[ref]; }
  }
}, 1000);
onBeforeUnmount(() => { gone = true; closeDialog(); clearInterval(timer); clearTimeout(copiedTimer); controllers.forEach(c => c.abort()); });
function isInvalid(link: SearchLink) {
  return invalidLink(resolved[link.linkRef]);
}
async function copyDeferred(text: Promise<string>) {
  if (!navigator.clipboard) throw new Error('当前浏览器无法访问剪贴板，请使用打开链接');
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then(value => new Blob([value], { type: 'text/plain' })) })]);
    } else {
      await navigator.clipboard.writeText(await text);
    }
  } catch (error) {
    if (error instanceof Error && ['NotAllowedError', 'SecurityError'].includes(error.name)) {
      throw new Error('复制未完成，请允许剪贴板访问后重试，或使用打开链接');
    }
    throw new Error('复制未完成，请重试，或使用打开链接');
  }
}
function closeDialog() {
  active?.controller.abort();
  active = undefined;
  dialog.value = null;
}
function failDialog(message: string, retryable = true) {
  if (dialog.value) Object.assign(dialog.value, { status: 'error', message, retryable });
}
async function act(action: LinkAction, resource: DisplaySearchResult, link: SearchLink) {
  const ref = link.linkRef;
  if (loading[ref] || dialog.value?.status === 'loading') return;
  const controller = new AbortController(); controllers.add(controller);
  const operation = { resource, link, action, controller, value: undefined as ResolvedLink | undefined };
  active = operation;
  loading[ref] = action;
  now.value = Date.now();
  dialog.value = { status: 'loading', action, name: resource.name, provider: props.platformLabel(link.type), startedAt: now.value };
  if (copiedKey.value === ref) copiedKey.value = '';
  const resume = !!keys[ref];
  try {
    keys[ref] ||= crypto.randomUUID();
    const completed = await executeLinkAction(action, async () => {
      const value = await resolveLink(resource.resultRef, ref, keys[ref]!, controller.signal, resume);
      if (gone || controller.signal.aborted) throw new Error('操作已取消');
      operation.value = value;
      resolved[ref] = value;
      delete keys[ref];
      return value;
    }, {
      prepareOpen: () => ({ navigate: url => { if (active === operation && dialog.value) Object.assign(dialog.value, { status: 'ready', url, message: undefined }); }, close() {} }),
      copy: copyDeferred,
      invalid: value => { if (active === operation && !controller.signal.aborted) failDialog(value.reasonCode === 'resource_missing' ? '资源已不存在，试试其他搜索结果。' : '这个链接已失效，试试其他搜索结果。', false); },
      failed: message => { if (active === operation && !controller.signal.aborted) failDialog(message); },
    });
    if (active === operation && !controller.signal.aborted && completed && !invalidLink(completed) && action === 'copy') finishCopy(ref, completed);
  } catch (error) {
    if (active === operation && !controller.signal.aborted) failDialog(error instanceof Error ? error.message : '操作未能开始，请稍后重试。');
  } finally {
    loading[ref] = undefined;
    controllers.delete(controller);
  }
}
function finishCopy(ref: string, value: ResolvedLink) {
  if (dialog.value) Object.assign(dialog.value, { status: 'success', message: value.password ? '去浏览器或网盘 App 粘贴打开，提取码也已为你保留。' : '去浏览器或网盘 App 粘贴打开。' });
  copiedKey.value = ref;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => { copiedKey.value = ''; }, 2400);
}
async function copyReady() {
  const operation = active;
  if (!operation || !dialog.value || dialog.value.status === 'loading') return;
  if (!usable(operation.value) || invalidLink(operation.value)) { failDialog('链接需要重新获取，请再试一次。'); operation.value = undefined; return; }
  Object.assign(dialog.value, { status: 'loading', action: 'copy', message: '正在复制到剪贴板。' });
  const result = await executeLinkAction('copy', async () => operation.value!, {
    prepareOpen: () => ({ navigate() {}, close() {} }), copy: copyDeferred, invalid: () => {},
    failed: message => { if (active === operation) failDialog(message); },
  });
  if (active === operation && result) finishCopy(operation.link.linkRef, result);
}
function retryDialog() {
  const operation = active;
  if (!operation) return;
  if (usable(operation.value) && !invalidLink(operation.value)) return copyReady();
  return act(operation.action, operation.resource, operation.link);
}
function openReady(event: MouseEvent) {
  if (!usable(active?.value) || invalidLink(active?.value)) { event.preventDefault(); if (active) active.value = undefined; failDialog('链接需要重新获取，请再试一次。'); }
}
async function copyPassword(ref: string) {
  if (gone || loading[ref] || copyingPassword.value) return;
  const value = resolved[ref];
  if (!value?.password || !usable(value) || invalidLink(value)) {
    showToast('请先重新获取可用链接', 'error');
    return;
  }
  copyingPassword.value = ref;
  try {
    await copyDeferred(Promise.resolve(value.password));
    if (!gone) showToast('提取码已复制', 'success');
  } catch (error) {
    if (!gone) showToast(error instanceof Error ? error.message : '提取码复制失败', 'error');
  } finally { copyingPassword.value = ''; }
}
const visibleItems = computed(() => props.expanded ? props.items : props.items.slice(0, props.initialVisible));

</script>

<style scoped>
.result-card {
  width: 100%;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--border-light);
  border-radius: 18px;
  background: var(--bg-primary);
  box-shadow: var(--shadow-sm);
}

.result-card--flat { border-radius: 18px; }

.card-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 15px 18px;
  border-bottom: 1px solid var(--border-light);
}

.header-mark {
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  border-radius: 12px;
  background: color-mix(in srgb, var(--mark-color) 14%, var(--bg-primary));
  color: var(--mark-color);
  font-size: 19px;
}

.header-info { min-width: 0; flex: 1; }
.platform-title { margin: 0; color: var(--text-primary); font-size: 16px; font-weight: 750; }
.resource-count { display: block; margin-top: 3px; color: var(--text-tertiary); font-size: 12px; }

.expand-btn,
.load-more-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--border-light);
  border-radius: 9px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
  font-weight: 650;
}
.expand-btn { padding: 7px 10px; }
.expand-btn:hover, .load-more-btn:hover { border-color: var(--primary); color: var(--primary); background: var(--primary-soft); }

.resource-list { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1px; width: 100%; max-width: 100%; min-width: 0; margin: 0; padding: 0; list-style: none; background: var(--border-light); }
.resource-item { width: 100%; max-width: 100%; min-width: 0; padding: 18px; background: var(--bg-primary); transition: background-color var(--transition-fast); }
.resource-item:hover { background: color-mix(in srgb, var(--bg-primary) 94%, var(--primary)); }

.resource-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; min-width: 0; }
.resource-heading-main { min-width: 0; flex: 1; }
.resource-title { margin: 0; color: var(--text-primary); font-size: 16px; font-weight: 700; line-height: 1.45; overflow-wrap: anywhere; }
.resource-date { flex-shrink: 0; padding-top: 3px; color: var(--text-tertiary); font-size: 11px; white-space: nowrap; }

.resource-links { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; width: 100%; max-width: 100%; min-width: 0; margin-top: 14px; }
.link-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; width: 100%; max-width: 100%; min-width: 0; padding: 10px 11px; border: 1px solid var(--border-light); border-radius: 12px; background: var(--bg-secondary); overflow: hidden; }
.link-progress { flex-basis: 100%; grid-column: 1 / -1; min-width: 0; }
.progress-caption { display: flex; align-items: center; gap: 8px; color: var(--text-secondary); font-size: 12px; }
.progress-elapsed { margin-left: auto; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
.progress-spinner { width: 13px; height: 13px; border: 1.5px solid var(--border-light); border-top-color: var(--text-primary); border-radius: 50%; animation: link-spin .8s linear infinite; }
.progress-track { height: 3px; margin-top: 9px; border-radius: 999px; overflow: hidden; background: var(--border-light); }
.progress-track span { display: block; width: 35%; height: 100%; border-radius: inherit; background: var(--text-secondary); animation: link-sweep 1.6s ease-in-out infinite; }
@keyframes link-spin { to { transform: rotate(360deg); } }
@keyframes link-sweep { from { transform: translateX(-100%); } to { transform: translateX(300%); } }
@media (prefers-reduced-motion: reduce) { .progress-spinner, .progress-track span { animation: none; } }
.link-main { display: flex; min-width: 0; flex: 1; align-items: center; gap: 8px; flex-wrap: wrap; }
.link-provider { line-height: 20px; min-width: 0; max-width: 100%; color: var(--text-primary); font-size: 13px; font-weight: 700; overflow-wrap: anywhere; word-break: break-word; }
.password-badge { display: inline-flex; align-items: center; min-width: 0; max-width: 100%; gap: 4px; color: var(--text-tertiary); font-size: 11px; overflow-wrap: anywhere; word-break: break-word; }
.password-badge { padding: 4px 6px; border: 1px solid var(--border-light); border-radius: 6px; background: transparent; font-family: inherit; cursor: pointer; }
.password-badge:disabled { opacity: .5; cursor: not-allowed; }
.password-badge:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.link-actions { display: flex; align-items: center; min-width: 0; gap: 7px; flex: 0 1 auto; }
.open-btn, .copy-btn { display: inline-flex; align-items: center; justify-content: center; min-width: 88px; min-height: 44px; max-width: 100%; gap: 5px; padding: 7px 12px; border: 1px solid var(--border-light); border-radius: 8px; background: var(--bg-primary); color: var(--text-secondary); cursor: pointer; font-size: 12px; font-weight: 650; text-decoration: none; white-space: nowrap; }
.open-btn:hover:not(:disabled), .copy-btn:hover:not(:disabled) { border-color: var(--primary); color: var(--primary); background: var(--primary-soft); }
.open-btn:disabled, .copy-btn:disabled { opacity: .5; cursor: not-allowed; }
.open-btn:focus-visible, .copy-btn:focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; }
.card-footer { display: flex; justify-content: center; padding: 12px; border-top: 1px solid var(--border-light); background: var(--bg-primary); }
.load-more-btn { padding: 8px 12px; }

@media (max-width: 560px) {
  .resource-item { padding: 15px 13px; }
  .resource-heading { display: block; }
  .resource-date { display: block; margin-top: 7px; padding: 0; }
  /* 移动端链接行改成两行布局，避免操作区挤压来源名称导致中文逐字竖排。 */
  .link-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    align-items: center;
    gap: 10px;
  }
  .link-main {
    grid-column: 1;
    min-height: 30px;
    width: 100%;
    max-width: 100%;
    align-items: center;
    flex-direction: row;
    flex-wrap: wrap;
    gap: 4px 8px;
  }
  .link-actions {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    width: 100%;
    max-width: 100%;
    padding-left: 0;
  }
  .open-btn, .copy-btn {
    width: 100%;
    min-width: 0;
    justify-content: center;
  }
}

.result-card, .result-card--flat { border-radius: 12px; box-shadow: none; }
.resource-list { padding: 0 18px; gap: 0; background: var(--bg-primary); }
.resource-item { position: relative; display: grid; grid-template-columns: 56px minmax(0, 1fr); column-gap: 20px; padding: 22px 6px; border-bottom: 1px solid var(--border-light); }
.resource-item:last-child { border-bottom: 0; }
.resource-item:hover { background: #fffdf9; }
.resource-art { display: grid; place-items: center; grid-column: 1; grid-row: 1 / 3; align-self: start; margin-top: 2px; width: 56px; height: 62px; border-radius: 12px; background: #fff3e5; color: #ff8a32; }
.resource-heading { grid-column: 2; padding-right: 245px; }
.resource-title { font-size: 17px; line-height: 1.5; }
.resource-title mark { background: transparent; color: var(--primary); }
.resource-links { grid-column: 2; margin-top: 7px; }
.link-row { padding: 0; border: 0; border-radius: 0; background: transparent; overflow: visible; min-height: 24px; }
.link-main { padding-right: 245px; }
.link-provider { display: inline-flex; align-items: center; padding: 1px 9px; border-radius: 999px; color: #fff; background: #8d8172; font-size: 10px; font-weight: 550; }
.link-provider[data-provider="quark"] { background: #7450ff; }
.link-provider[data-provider="baidu"] { background: #2981f5; }
.link-provider[data-provider="aliyun"] { background: #ff8a1c; }
.link-provider[data-provider="uc"] { background: #ec6c21; }
.resource-date { padding: 0; font-size: 11px; color: var(--text-tertiary); }
.link-actions { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); gap: 10px; }
.open-btn, .copy-btn { min-height: 40px; padding: 8px 14px; font-size: 12px; }
.open-btn { border-color: var(--primary); color: var(--primary); }
.copy-btn { color: var(--text-secondary); }
.link-progress { padding-right: 245px; }
.progress-track span { background: var(--primary); }
@media(max-width:760px) { .resource-list { padding: 0 12px; } .resource-item { grid-template-columns: 40px minmax(0,1fr); gap: 0 12px; padding: 18px 0; } .resource-art { width: 40px; height: 46px; border-radius: 9px; } .resource-art svg { width: 24px; } .resource-heading, .link-main, .link-progress { padding-right: 0; } .resource-title { font-size: 15px; } .link-actions { position: static; transform: none; display: flex; width: auto; margin-top: 6px; } .link-row { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; } .link-main { min-height: 0; gap: 6px; } .resource-date { margin: 0; } .open-btn, .copy-btn { width: auto; min-width: 90px; } .link-progress { width: 100%; } }
</style>
