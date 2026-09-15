<template>
  <section :class="['result-card', { 'result-card--flat': !showHeader }]">
    <header v-if="showHeader" class="card-header">
      <div class="header-mark" :style="{ '--mark-color': color }" aria-hidden="true">{{ icon }}</div>
      <div class="header-info">
        <h2 class="platform-title">{{ title }}</h2>
        <span class="resource-count">{{ items.length }} 个资源</span>
      </div>
      <button v-if="canToggleCollapse" class="expand-btn" type="button" @click="$emit('toggle')">
        {{ expanded ? '收起' : '展开' }}
      </button>
    </header>

    <ul class="resource-list">
      <li v-for="resource in visibleItems" :key="resource.id" class="resource-item">
        <div class="resource-heading">
          <div class="resource-heading-main">
            <h3 class="resource-title">{{ resource.name }}</h3>
            <p v-if="resource.description" class="resource-description">{{ resource.description }}</p>
          </div>
          <time v-if="resource.datetime" class="resource-date" :datetime="resource.datetime">{{ resource.datetime }}</time>
        </div>

        <div v-if="resource.cloud_types.length || resource.tags?.length" class="resource-meta">
          <div class="meta-tags">
            <button
              v-for="type in resource.cloud_types"
              :key="type"
              type="button"
              :class="['meta-tag', 'platform', { active: activePlatform === type }]"
              :aria-pressed="activePlatform === type"
              :title="`${platformLabel(type)}：点击筛选`"
              @click="$emit('filter-platform', type)">
              <span class="tag-dot" aria-hidden="true"></span>
              {{ platformLabel(type) }}
            </button>
            <span v-for="tag in resource.tags" :key="tag" class="meta-tag tag">{{ tag }}</span>
          </div>
        </div>

        <div class="resource-links" aria-label="资源链接">
          <div v-for="link in resource.links" :key="linkKey(link)" class="link-row">
            <span class="link-provider-icon" aria-hidden="true">{{ typeIcon(link.type) }}</span>
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
              <button class="copy-btn" type="button" :aria-label="`复制${platformLabel(link.type)}链接`" @click="copy(link.url, linkKey(link))">
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
      <button class="load-more-btn" type="button" @click="$emit('toggle')">
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
import type { Link, SearchResult } from "~/server/core/types/models";

const props = withDefaults(defineProps<{
  title: string;
  color: string;
  icon: string;
  items: SearchResult[];
  expanded: boolean;
  initialVisible: number;
  canToggleCollapse?: boolean;
  showHeader?: boolean;
  activePlatform?: string;
  platformLabel?: (type: string) => string;
}>(), {
  canToggleCollapse: false,
  showHeader: true,
  activePlatform: "all",
  platformLabel: (type: string) => type || "其他",
});

const emit = defineEmits<{
  (event: "toggle"): void;
  (event: "copy", url: string): void;
  (event: "filter-platform", type: string): void;
}>();

const copiedKey = ref("");
const visibleItems = computed(() => props.expanded ? props.items : props.items.slice(0, props.initialVisible));

function linkKey(link: Link): string {
  return `${link.type}|${link.url}|${link.password || ""}`;
}

function typeIcon(type: string): string {
  if (type === "magnet") return "⚡";
  if (type === "others") return "↗";
  return "☁";
}

function copy(url: string, key: string) {
  copiedKey.value = key;
  emit("copy", url);
  window.setTimeout(() => {
    if (copiedKey.value === key) copiedKey.value = "";
  }, 1600);
}
</script>

<style scoped>
.result-card {
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

.resource-list { display: grid; gap: 1px; margin: 0; padding: 0; list-style: none; background: var(--border-light); }
.resource-item { padding: 18px; background: var(--bg-primary); transition: background-color var(--transition-fast); }
.resource-item:hover { background: color-mix(in srgb, var(--bg-primary) 94%, var(--primary)); }

.resource-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.resource-heading-main { min-width: 0; flex: 1; }
.resource-title { margin: 0; color: var(--text-primary); font-size: 16px; font-weight: 700; line-height: 1.45; overflow-wrap: anywhere; }
.resource-description { display: -webkit-box; overflow: hidden; margin: 6px 0 0; color: var(--text-secondary); font-size: 13px; line-height: 1.65; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.resource-date { flex-shrink: 0; padding-top: 3px; color: var(--text-tertiary); font-size: 11px; white-space: nowrap; }

.resource-meta { margin-top: 12px; }
.meta-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.meta-tag { display: inline-flex; align-items: center; gap: 5px; padding: 5px 9px; border: 1px solid var(--border-light); border-radius: 999px; color: var(--text-secondary); background: var(--bg-secondary); font-size: 11px; line-height: 1; }
button.meta-tag { cursor: pointer; font-family: inherit; }
button.meta-tag:hover, button.meta-tag.active { border-color: color-mix(in srgb, var(--primary) 45%, var(--border-light)); color: var(--primary); background: var(--primary-soft); }
.tag-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }

.resource-links { display: grid; gap: 8px; margin-top: 14px; }
.link-row { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 10px 11px; border: 1px solid var(--border-light); border-radius: 12px; background: var(--bg-secondary); }
.link-provider-icon { display: grid; width: 30px; height: 30px; flex: 0 0 30px; place-items: center; border-radius: 9px; background: var(--bg-primary); color: var(--primary); font-size: 14px; }
.link-main { display: flex; min-width: 0; flex: 1; align-items: center; gap: 8px; flex-wrap: wrap; }
.link-provider { color: var(--text-primary); font-size: 13px; font-weight: 700; }
.password-badge { display: inline-flex; align-items: center; gap: 4px; color: var(--text-tertiary); font-size: 11px; }
.link-actions { display: flex; align-items: center; gap: 7px; flex: 0 0 auto; }
.open-btn, .copy-btn { display: inline-flex; align-items: center; gap: 5px; padding: 7px 9px; border: 1px solid var(--border-light); border-radius: 8px; background: var(--bg-primary); color: var(--text-secondary); cursor: pointer; font-size: 11px; font-weight: 650; text-decoration: none; white-space: nowrap; }
.open-btn:hover, .copy-btn:hover { border-color: var(--primary); color: var(--primary); background: var(--primary-soft); }
.card-footer { display: flex; justify-content: center; padding: 12px; border-top: 1px solid var(--border-light); background: var(--bg-primary); }
.load-more-btn { padding: 8px 12px; }

@media (max-width: 560px) {
  .resource-item { padding: 15px 13px; }
  .resource-heading { display: block; }
  .resource-date { display: block; margin-top: 7px; padding: 0; }
  .link-row { align-items: flex-start; }
  .link-main { align-items: flex-start; flex-direction: column; gap: 4px; }
  .link-actions { width: 100%; justify-content: flex-end; }
  .open-btn, .copy-btn { flex: 1; justify-content: center; }
}
</style>
