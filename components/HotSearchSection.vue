<template>
  <div v-if="!loading && searches.length === 0" class="hidden"></div>

  <div v-else class="hot-search-section">
    <div class="cloud-container">
      <div v-if="loading" class="loading-state">
        <div class="spinner"></div>
        <span>搜索热度加载中…</span>
      </div>

      <ClientOnly>
        <div
          v-show="!loading && searches.length > 0"
          class="tag-cloud-card"
        >
          <div class="cloud-title">热门搜索</div>
          <div
            ref="tagCloudRef"
            class="tag-cloud-wrap"
            @click="onContainerClick"
            @mouseenter="pauseTagCloud"
            @mouseleave="resumeTagCloud"
            @focusin="pauseTagCloud"
            @focusout="resumeTagCloud"
          />
        </div>
        <template #fallback>
          <div class="tag-cloud-card">
            <div class="cloud-title">热门搜索</div>
            <div class="tag-cloud-placeholder" />
          </div>
        </template>
      </ClientOnly>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onBeforeUnmount, nextTick } from "vue";
import type { TagCloud as TagCloudInstanceApi, TagCloudOptions } from "TagCloud";

type PanHubTagCloudOptions = TagCloudOptions & { direction?: number };

interface Props {
  onSearch: (term: string) => void;
}

interface HotSearchItem {
  term: string;
  score: number;
  lastSearched: number;
  createdAt: number;
}

const props = defineProps<Props>();

const loading = ref(false);
const searches = ref<HotSearchItem[]>([]);
const hasInitialized = ref(false);
const tagCloudRef = ref<HTMLElement | null>(null);
const isUpdating = ref(false);
let tagCloudInstance: TagCloudInstanceApi | null = null;
let tagCloudPaused = false;
let prefersReducedMotion = false;
let updateTimer: ReturnType<typeof setTimeout> | null = null;

// 热搜词展示截断：过长的词会撑爆标签云，点击时再映射回完整原词
const HOT_TERM_MAX_CHARS = 14;
let displayToTerm = new Map<string, string>();

function truncateTerm(term: string) {
  return term.length > HOT_TERM_MAX_CHARS ? `${term.slice(0, HOT_TERM_MAX_CHARS)}…` : term;
}

async function fetchHotSearches() {
  loading.value = true;
  try {
    const response = await fetch("/api/hot-searches?limit=25");
    const data = await response.json();
    if (data.code === 0 && data.data?.hotSearches) {
      searches.value = data.data.hotSearches
        .sort((a: HotSearchItem, b: HotSearchItem) => b.score - a.score)
        .slice(0, 25);
    } else {
      searches.value = [];
    }
  } catch {
    searches.value = [];
  } finally {
    loading.value = false;
  }
}

async function init() {
  if (hasInitialized.value) return;
  hasInitialized.value = true;
  await fetchHotSearches();
}

async function refresh() {
  await fetchHotSearches();
}

function getTerms(): string[] {
  displayToTerm = new Map();
  const displayTerms: string[] = [];
  for (const s of searches.value) {
    const display = truncateTerm(s.term);
    if (!displayToTerm.has(display)) displayToTerm.set(display, s.term);
    displayTerms.push(display);
  }
  return displayTerms;
}

async function initTagCloud() {
  if (!tagCloudRef.value || typeof window === "undefined") return;
  const terms = getTerms();
  if (terms.length === 0) return;

  // 防抖：避免频繁更新
  if (isUpdating.value) {
    if (updateTimer) clearTimeout(updateTimer);
    updateTimer = setTimeout(() => {
      isUpdating.value = false;
      initTagCloud();
    }, 300);
    return;
  }

  if (tagCloudInstance) {
    isUpdating.value = true;
    tagCloudInstance.update(terms);
    // 更新完成后重置状态
    setTimeout(() => {
      isUpdating.value = false;
    }, 100);
    return;
  }

  prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  tagCloudPaused = prefersReducedMotion;

  const TagCloud = (await import("TagCloud")).default as unknown as (
    container: Element,
    texts: string[],
    options?: PanHubTagCloudOptions,
  ) => TagCloudInstanceApi;
  // initTagCloud can be triggered by both the data watcher and the page ref;
  // re-check after the async import so concurrent calls cannot mount two loops.
  if (tagCloudInstance || !tagCloudRef.value) return;
  tagCloudInstance = TagCloud(tagCloudRef.value, terms, {
    radius: 150,
    maxSpeed: "slow",
    initSpeed: "slow",
    direction: 135,
    keep: true,
    containerClass: "hot-tagcloud",
    itemClass: "hot-tagcloud-item",
  });
  if (tagCloudPaused) tagCloudInstance.pause();
}

function pauseTagCloud() {
  tagCloudPaused = true;
  tagCloudInstance?.pause();
}

function resumeTagCloud() {
  tagCloudPaused = prefersReducedMotion;
  if (!prefersReducedMotion) tagCloudInstance?.resume();
}

function destroyTagCloud() {
  if (updateTimer) {
    clearTimeout(updateTimer);
    updateTimer = null;
  }
  if (tagCloudInstance) {
    tagCloudInstance.destroy();
    tagCloudInstance = null;
  }
  isUpdating.value = false;
}

function onContainerClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (target?.classList?.contains("hot-tagcloud-item")) {
    const display = target.innerText?.trim();
    if (display) props.onSearch(displayToTerm.get(display) ?? display);
  }
}

watch(
  () => [searches.value.length, loading.value] as const,
  async ([len, ld]) => {
    if (ld) return;
    if (len === 0) {
      // The ClientOnly node is replaced when the API returns an empty list;
      // release the old instance so a later refresh can mount a fresh cloud.
      destroyTagCloud();
      return;
    }
    await nextTick();
    initTagCloud();
  },
  { flush: "post" }
);

onBeforeUnmount(() => {
  destroyTagCloud();
});

defineExpose({ init, refresh });
</script>

<style scoped>
.hot-search-section {
  width: 100%;
}

.cloud-container {
  width: 100%;
}

/* 白色扁平卡片 + 灰色小标题 */
.tag-cloud-card {
  background: var(--bg-primary);
  border: 1px solid var(--border-light);
  border-radius: 16px;
  box-shadow: var(--shadow-sm);
  padding: 20px;
}

.cloud-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-tertiary);
  text-align: center;
  margin-bottom: 8px;
}

.tag-cloud-wrap {
  min-height: 320px;
  cursor: pointer;
}

.tag-cloud-placeholder {
  min-height: 300px;
}

/* 覆盖 TagCloud 默认样式，适配项目主题 */
.tag-cloud-card :deep(.hot-tagcloud) {
  position: relative;
  width: 100%;
  height: 300px;
  /* GPU 加速 */
  transform: translateZ(0);
  will-change: transform;
}

.tag-cloud-card :deep(.hot-tagcloud-item) {
  color: var(--text-secondary, #4b5563) !important;
  font-weight: 600 !important;
  font-family: inherit !important;
  cursor: pointer;
  transition: color 0.15s ease;
  /* GPU 加速 */
  transform: translateZ(0);
  will-change: transform, color;
}

.tag-cloud-card :deep(.hot-tagcloud-item:hover) {
  color: var(--primary, #2563eb) !important;
}

.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px 20px;
  color: var(--text-secondary);
  background: var(--bg-primary);
  border: 1px solid var(--border-light);
  border-radius: 16px;
}

.spinner {
  width: 28px;
  height: 28px;
  border: 3px solid var(--border-light);
  border-top-color: var(--text-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 640px) {
  .tag-cloud-card {
    padding: 12px;
  }

  .tag-cloud-wrap {
    min-height: 260px;
  }

  .tag-cloud-card :deep(.hot-tagcloud) {
    height: 240px;
  }

  .loading-state {
    padding: 24px 12px;
  }
}

@media (prefers-color-scheme: dark) {
  .tag-cloud-card :deep(.hot-tagcloud-item) {
    color: #9ca3af !important;
  }

  .tag-cloud-card :deep(.hot-tagcloud-item:hover) {
    color: #60a5fa !important;
  }
}

.hidden {
  display: none;
}
</style>
