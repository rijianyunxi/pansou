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

        <div v-if="resource.tags?.length" class="resource-meta">
          <div class="meta-tags">
            <span v-for="tag in resource.tags" :key="tag" class="meta-tag tag">{{ tag }}</span>
          </div>
        </div>

        <div class="resource-links" aria-label="资源链接">
          <div v-for="link in resource.links" :key="linkKey(link)" class="link-row">
            <span class="link-provider-icon" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path v-if="link.type === 'magnet'" d="m13 2-9 12h7l-1 8 10-12h-7z" />
                <path v-else-if="link.type === 'others'" d="M7 17 17 7M7 7h10v10" />
                <path v-else d="M6 19a4 4 0 0 1-.5-8A6.5 6.5 0 0 1 18 9a5 5 0 0 1 0 10Z" />
              </svg>
            </span>
            <div class="link-main">
              <span class="link-provider">{{ platformLabel(link.type) }}</span>
              <span v-if="link.password" class="password-badge">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <rect x="3" y="11" width="18" height="11" rx="2"></rect>
                  <circle cx="12" cy="16" r="1"></circle>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                </svg>
                提取码 {{ link.password }}
              </span>
            </div>
            <div class="link-actions">
              <a
                class="open-btn"
                :href="link.url"
                target="_blank"
                rel="noopener noreferrer nofollow"
                :aria-label="`打开${platformLabel(link.type)}链接`"
                title="打开链接">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <path d="M14 3h7v7"></path>
                  <path d="M10 14 21 3"></path>
                  <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"></path>
                </svg>
                打开链接
              </a>
              <button class="copy-btn" type="button" :aria-label="`复制${platformLabel(link.type)}链接`" @click="copy(link)">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <rect x="9" y="9" width="13" height="13" rx="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
                {{ copiedKey === linkKey(link) ? '已复制' : '复制' }}
              </button>
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
import { computed, ref } from "vue";
import type { Link } from "~/server/core/types/models";
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
const visibleItems = computed(() => props.expanded ? props.items : props.items.slice(0, props.initialVisible));

function linkKey(link: Link): string {
  return `${link.type}|${link.url}|${link.password || ""}`;
}

async function copy(link: Link) {
  const key = linkKey(link);
  try {
    await navigator.clipboard.writeText(link.url);
  } catch {
    return;
  }
  copiedKey.value = key;
  window.setTimeout(() => {
    if (copiedKey.value === key) copiedKey.value = "";
  }, 1600);
}

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

.resource-meta { margin-top: 8px; }
.meta-tags { display: flex; flex-wrap: wrap; min-width: 0; gap: 12px 8px; padding: 6px 0; }
.meta-tag { display: inline-flex; align-items: center; gap: 5px; min-height: 28px; padding: 4px 8px; border: 1px solid var(--border-light); border-radius: 6px; color: var(--text-secondary); background: var(--bg-secondary); font-size: 11px; line-height: 18px; }

.resource-links { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; width: 100%; max-width: 100%; min-width: 0; margin-top: 14px; }
.link-row { display: flex; align-items: center; gap: 10px; width: 100%; max-width: 100%; min-width: 0; padding: 10px 11px; border: 1px solid var(--border-light); border-radius: 12px; background: var(--bg-secondary); overflow: hidden; }
.link-provider-icon { display: grid; width: 30px; height: 30px; flex: 0 0 30px; place-items: center; border-radius: 9px; background: var(--bg-primary); color: var(--primary); font-size: 14px; }
.link-main { display: flex; min-width: 0; flex: 1; align-items: center; gap: 8px; flex-wrap: wrap; }
.link-provider { line-height: 20px; min-width: 0; max-width: 100%; color: var(--text-primary); font-size: 13px; font-weight: 700; overflow-wrap: anywhere; word-break: break-word; }
.password-badge { display: inline-flex; align-items: center; min-width: 0; max-width: 100%; gap: 4px; color: var(--text-tertiary); font-size: 11px; overflow-wrap: anywhere; word-break: break-word; }
.link-actions { display: flex; align-items: center; min-width: 0; gap: 7px; flex: 0 1 auto; }
.open-btn, .copy-btn { display: inline-flex; align-items: center; min-width: 0; max-width: 100%; gap: 5px; padding: 7px 9px; border: 1px solid var(--border-light); border-radius: 8px; background: var(--bg-primary); color: var(--text-secondary); cursor: pointer; font-size: 11px; font-weight: 650; text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.open-btn:hover, .copy-btn:hover { border-color: var(--primary); color: var(--primary); background: var(--primary-soft); }
.card-footer { display: flex; justify-content: center; padding: 12px; border-top: 1px solid var(--border-light); background: var(--bg-primary); }
.load-more-btn { padding: 8px 12px; }

@media (max-width: 560px) {
  .resource-item { padding: 15px 13px; }
  .resource-heading { display: block; }
  .resource-date { display: block; margin-top: 7px; padding: 0; }
  /* 移动端链接行改成两行布局，避免操作区挤压来源名称导致中文逐字竖排。 */
  .link-row {
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr);
    align-items: center;
    gap: 10px;
  }
  .link-provider-icon { grid-column: 1; }
  .link-main {
    grid-column: 2;
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
