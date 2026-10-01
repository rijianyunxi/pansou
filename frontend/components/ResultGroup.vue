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
        <div class="resource-heading">
          <div class="resource-heading-main">
            <h3 class="resource-title">{{ resource.name }}</h3>
            <ResourceDescription :text="resource.description" />
          </div>
          <time v-if="resource.datetime" class="resource-date" :datetime="resource.datetime">{{ resource.datetime }}</time>
        </div>

        <div class="resource-links" aria-label="资源链接">
          <div v-for="link in resource.links" :key="link.linkRef" class="link-row">
            <div class="link-main" aria-live="polite">
              <span class="link-provider">{{ platformLabel(link.type) }}</span>
              <span v-if="resolved[link.linkRef]?.password" class="password-badge">提取码 {{ resolved[link.linkRef]?.password }}</span>
            </div>
            <div class="link-actions">
              <button class="open-btn" type="button" :disabled="!!loading[link.linkRef]" :aria-busy="loading[link.linkRef] === 'open'" title="获取链接后打开" @click="act('open', resource, link)">{{ loading[link.linkRef] === 'open' ? '正在打开…' : '打开链接' }}</button>
              <button class="copy-btn" type="button" :disabled="!!loading[link.linkRef]" :aria-busy="loading[link.linkRef] === 'copy'" title="获取并复制链接及提取码" @click="act('copy', resource, link)">{{ loading[link.linkRef] === 'copy' ? '正在复制…' : copiedKey === link.linkRef ? '已复制' : '复制链接' }}</button>
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
</template>

<script setup lang="ts">
import { computed, ref, reactive, inject, onBeforeUnmount } from "vue";
import { resolveLink } from '~/utils/linkResolution';
import { executeLinkAction, invalidLink, type LinkAction } from '~/utils/linkActions';
import ResourceDescription from "./ResourceDescription.vue";
import type { SearchLink, ResolvedLink } from "~/shared/apiModels";
import type { DisplaySearchResult } from "~/utils/resultDisplay";

const props = withDefaults(defineProps<{
  title: string;
  color: string;
  icon: string;
  items: DisplaySearchResult[];
  expanded: boolean;
  initialVisible: number;
  canToggleCollapse?: boolean;
  showHeader?: boolean;
  platformLabel?: (type: string) => string;
}>(), {
  canToggleCollapse: false,
  showHeader: true,
  platformLabel: (type: string) => type || "其他",
});

const emit = defineEmits<{
  (event: "toggle"): void;
}>();

const copiedKey = ref("");
const resolved = reactive<Record<string, ResolvedLink>>({});
const loading = reactive<Record<string, LinkAction | undefined>>({});
const keys = reactive<Record<string, string>>({});
const controllers = new Set<AbortController>();
const showToast = inject<(message: string, type?: 'info' | 'success' | 'error') => void>('showToast', () => {});
let gone = false;
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
const timer = setInterval(() => {
  for (const [ref, value] of Object.entries(resolved)) {
    if ([value.deliveryExpiresAt, value.shareExpiresAt].some(t => t && Date.parse(t) <= Date.now())) { delete resolved[ref]; delete keys[ref]; }
  }
}, 1000);
onBeforeUnmount(() => { gone = true; clearInterval(timer); clearTimeout(copiedTimer); controllers.forEach(c => c.abort()); });
function isInvalid(link: SearchLink) {
  return invalidLink(resolved[link.linkRef]);
}
function prepareOpen() {
  const popup = window.open('about:blank', '_blank');
  if (popup) {
    popup.opener = null;
    popup.document.title = '正在打开链接';
    popup.document.body.textContent = '正在获取链接，请稍候…';
  }
  return {
    navigate(url: string) { if (popup && !popup.closed) popup.location.replace(url); else window.location.assign(url); },
    close() { if (popup && !popup.closed) popup.close(); },
  };
}
function copyDeferred(text: Promise<string>) {
  if (!navigator.clipboard) throw new Error('当前浏览器无法访问剪贴板，请使用打开链接');
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    return navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then(value => new Blob([value], { type: 'text/plain' })) })]);
  }
  return text.then(value => navigator.clipboard.writeText(value));
}
async function act(action: LinkAction, resource: DisplaySearchResult, link: SearchLink) {
  const ref = link.linkRef;
  if (loading[ref]) return;
  loading[ref] = action;
  const resume = !!keys[ref];
  keys[ref] ||= crypto.randomUUID();
  const controller = new AbortController(); controllers.add(controller);
  try {
    const completed = await executeLinkAction(action, async () => {
      const value = await resolveLink(resource.resultRef, ref, keys[ref]!, controller.signal, resume);
      if (gone || controller.signal.aborted) throw new Error('操作已取消');
      resolved[ref] = value;
      // A fresh click revalidates the owned share; only unresolved operations retain their key.
      delete keys[ref];
      return value;
    }, {
      prepareOpen,
      copy: copyDeferred,
      invalid: value => showToast(value.reasonCode === 'resource_missing' ? '分享中的资源已不存在' : '原分享链接已失效', 'error'),
      failed: message => { if (!gone && !controller.signal.aborted) showToast(message, 'error'); },
    });
    if (!gone && completed && action === 'copy' && !isInvalid(link)) {
      copiedKey.value = ref;
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => { copiedKey.value = ''; }, 2400);
    }
  } finally { loading[ref] = undefined; controllers.delete(controller); }
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
.link-row { display: flex; align-items: center; gap: 10px; width: 100%; max-width: 100%; min-width: 0; padding: 10px 11px; border: 1px solid var(--border-light); border-radius: 12px; background: var(--bg-secondary); overflow: hidden; }
.link-main { display: flex; min-width: 0; flex: 1; align-items: center; gap: 8px; flex-wrap: wrap; }
.link-provider { line-height: 20px; min-width: 0; max-width: 100%; color: var(--text-primary); font-size: 13px; font-weight: 700; overflow-wrap: anywhere; word-break: break-word; }
.password-badge { display: inline-flex; align-items: center; min-width: 0; max-width: 100%; gap: 4px; color: var(--text-tertiary); font-size: 11px; overflow-wrap: anywhere; word-break: break-word; }
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
</style>
