<template>
  <div class="home">
    <!-- 简洁大标题 -->
    <header class="hero">
      <h1 class="hero-title">全网网盘资源搜索</h1>
      <p class="hero-description">
        网盘、磁力、公开频道，一个搜索框直达。
      </p>
    </header>

    <section class="search-workspace" aria-label="资源搜索">
      <div class="search-toolbar">
        <SearchScopeControl v-model="onlyUserTg" :count="settings.userTgChannels.length" :disabled="searchState.loading || !settingsReady" />
        <button type="button" class="manage-channels" :disabled="!settingsReady" @click="openChannelSettings">
          <span aria-hidden="true">+</span> {{ settings.userTgChannels.length ? '管理频道' : '添加频道' }}
        </button>
      </div>
      <SearchBox
        v-model="kw"
        :loading="searchState.loading"
        :paused="searchState.paused"
        :searched="searched"
        :search-disabled="!settingsReady || needsChannelConfiguration"
        :disabled-description-id="needsChannelConfiguration && !searchState.loading ? 'channel-configuration-hint' : undefined"
        :placeholder="onlyUserTg ? '搜索自定义频道…' : placeholder"
        @search="onSearch"
        @reset="fullReset"
        @pause="pauseSearch"
        @continue="handleContinueSearch" />
      <div class="channel-configuration-status" role="status" aria-live="polite">
        <div v-if="needsChannelConfiguration && !searchState.loading" class="channel-configuration-notice">
          <div id="channel-configuration-hint">
            <strong>「自定义频道」还没有可搜索的频道</strong>
            <p>先添加公开频道，再选择「自定义频道」开始搜索。</p>
          </div>
          <button type="button" class="configure-channels" @click="openChannelSettings">添加频道</button>
        </div>
      </div>
      <div class="scope-summary" aria-live="polite">
        <p v-if="onlyUserTg && settings.userTgChannels.length">只搜索你添加的 {{ settings.userTgChannels.length }} 个公开频道，不会请求其他配置来源。</p>
        <div v-if="onlyUserTg && settings.userTgChannels.length" class="channel-preview" aria-label="已添加的自定义频道">
          <span v-for="channel in settings.userTgChannels.slice(0, 3)" :key="channel" class="channel-chip">@{{ channel }}</span>
          <button v-if="settings.userTgChannels.length > 3" type="button" @click="openChannelSettings">+{{ settings.userTgChannels.length - 3 }} 个</button>
        </div>
        <p v-if="searchState.paused">继续时使用本次搜索的原始参数；频道修改将在下一次搜索生效。</p>
      </div>
    </section>
    <p v-if="storageError" class="search-notice" role="alert">{{ storageError }}</p>
    <p v-if="searchState.warning" class="search-notice" role="status">{{ searchState.warning }}</p>

    <!-- 热门搜索：仅未搜索时展示 -->
    <div v-if="!searched" class="hot-search-section">
      <HotSearchSection ref="hotSearchRef" :on-search="quickSearch" />
    </div>

    <!-- 统计和过滤器 -->
    <div v-if="searched" class="stats-bar">
      <div class="stats-content">
        <div class="stats-main">
          <span class="stat-item">
            <span class="stat-label">结果</span>
            <span class="stat-value">{{ searchState.total }}</span>
          </span>
          <span class="stat-item">
            <span class="stat-label">用时</span>
            <span class="stat-value">{{ searchState.elapsedMs }}ms</span>
          </span>
          <span v-if="searchState.deepLoading && !searchState.paused" class="loading-indicator">
            <span class="pulse-dot"></span>
            <span class="loading-text">持续搜索中…</span>
          </span>
          <span v-if="searchState.paused" class="paused-indicator-bar">
            <span class="pause-icon">⏸</span>
            <span class="paused-text">搜索已暂停</span>
          </span>
        </div>

        <!-- 平台过滤器 -->
        <div class="platform-filters" v-if="hasResults">
          <button
            :class="['filter-pill', { active: filterPlatform === 'all' }]"
            @click="filterPlatform = 'all'">
            全部
          </button>
          <button
            v-for="p in platforms"
            :key="p"
            :class="['filter-pill', { active: filterPlatform === p }]"
            @click="filterPlatform = p">
            {{ platformName(p) }}
          </button>
        </div>

        <!-- 排序选择器 -->
        <div class="sorter" v-if="hasResults">
          <select v-model="sortType" class="sort-select">
            <option value="default">默认排序</option>
            <option value="date-desc">最新发布</option>
            <option value="date-asc">最早发布</option>
            <option value="name-asc">名称 A→Z</option>
            <option value="name-desc">名称 Z→A</option>
          </select>
        </div>
      </div>
    </div>

    <!-- 搜索结果 -->
    <section v-if="hasResults" class="results-section">
      <div class="results-grid">
        <ResultGroup
          title="搜索结果"
          color="#9ca3af"
          icon="📦"
          :items="filteredResults"
          :expanded="true"
          :initial-visible="0"
          :show-header="false"
          :active-platform="filterPlatform"
          :platform-label="platformName"
          @filter-platform="handlePlatformFilter"
          @copy="copyLink" />
      </div>
    </section>

    <!-- 空状态：仅当搜索完全结束且无结果时显示，搜索进行中不显示 -->
    <section v-else-if="searched && !searchState.error && !searchState.loading && !searchState.deepLoading && !searchState.paused" class="empty-state">
      <div class="empty-card">
        <div class="empty-icon">🔍</div>
        <h3>未找到相关资源</h3>
        <p>试试其他关键词，或检查设置中的搜索来源是否已开启</p>
      </div>
    </section>

    <!-- 错误提示 -->
    <section v-if="searchState.error" class="error-alert">
      <span class="error-icon">⚠️</span>
      <span>{{ searchState.error }}</span>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, nextTick } from "vue";
import type { NormalizedSearchResult } from "~/server/core/types/models";

const config = useRuntimeConfig();
const apiBase = (config.public?.apiBase as string) || "/api";
const siteUrl = (config.public?.siteUrl as string) || "";

// 热搜组件引用
const hotSearchRef = ref<{ init: () => Promise<void>; refresh: () => Promise<void> } | null>(null);

// 页面加载时初始化热搜数据
onMounted(async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (hotSearchRef.value) await hotSearchRef.value.init();
});

// SEO 元数据
useSeoMeta({
  title: "PanHub - 全网最全的网盘搜索",
  description:
    "聚合阿里云盘、夸克、百度网盘、115、迅雷等平台，实时检索各类分享链接与资源，免费、快速、无广告。",
  ogTitle: "PanHub - 全网最全的网盘搜索",
  ogDescription:
    "聚合阿里云盘、夸克、百度网盘、115、迅雷等平台，实时检索各类分享链接与资源，免费、快速、无广告。",
  ogType: "website",
  ogSiteName: "PanHub",
  ogImage: siteUrl ? `${siteUrl}/og.svg` : "/og.svg",
  twitterCard: "summary_large_image",
  twitterTitle: "PanHub - 全网最全的网盘搜索",
  twitterDescription:
    "聚合阿里云盘、夸克、百度网盘、115、迅雷等平台，实时检索各类分享链接与资源，免费、快速、无广告。",
  twitterImage: siteUrl ? `${siteUrl}/og.svg` : "/og.svg",
});

useHead({
  link: [{ rel: "canonical", href: siteUrl ? `${siteUrl}/` : "/" }],
  meta: [
    {
      name: "keywords",
      content:
        "网盘搜索, 阿里云盘搜索, 夸克网盘搜索, 百度网盘搜索, 115 网盘, 迅雷云盘, 资源搜索, 盘搜, PanHub",
    },
  ],
  script: [
    {
      type: "application/ld+json",
      innerHTML: JSON.stringify({
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: "PanHub",
        url: siteUrl || "",
        potentialAction: {
          "@type": "SearchAction",
          target: (siteUrl || "") + "/?q={search_term_string}",
          "query-input": "required name=search_term_string",
        },
      }),
    },
  ],
});

// 搜索相关状态
const kw = ref("");
// Search scope is per visit, never a persisted channel preference.
const onlyUserTg = ref(false);
const placeholder =
  "搜索电影、剧集、资料等资源…";

// 排序和过滤
const sortType = ref<"default" | "date-desc" | "date-asc" | "name-asc" | "name-desc">("default");
const filterPlatform = ref<string>("all");

// 使用搜索 composable
const {
  state: searchState,
  searched,
  performSearch,
  resetSearch,
  copyLink,
  pauseSearch,
  continueSearch,
  hasResults,
} = useSearch();
const { settings, settingsReady, storageError } = useSettings();
const needsChannelConfiguration = computed(() => onlyUserTg.value && settings.value.userTgChannels.length === 0);
const openChannelSettings = inject<() => void>("openChannelSettings", () => {});
const auth = useAuth();
const requestUnlock = inject<(onSuccess?: () => void) => void>("requestUnlock");

// 获取搜索选项（用户自定义频道实时读取最新设置）
function getSearchOptions() {
  return {
    apiBase,
    keyword: kw.value,
    userTgChannels: settings.value.userTgChannels,
    onlyUserTg: onlyUserTg.value,
  };
}

// 记录热搜词
async function recordHotSearch(keyword: string) {
  const term = keyword?.trim();
  if (!term) return;
  try {
    await $fetch(`${apiBase}/hot-searches`, { method: "POST", body: { term } });
  } catch (_e) {}
}

// 执行实际搜索逻辑（供 requestUnlock 回调复用）
async function doSearch() {
  if (!settingsReady.value || needsChannelConfiguration.value || !kw.value.trim() || searchState.value.loading) return;
  const keyword = kw.value.trim();
  // 新搜索从全量结果视图开始，避免沿用上一次平台筛选状态。
  filterPlatform.value = "all";
  if (!onlyUserTg.value) recordHotSearch(keyword);
  await performSearch({
    ...getSearchOptions(),
    onAuthRequired: requestUnlock ?? undefined,
  });
}

// 搜索执行
async function onSearch() {
  if (!settingsReady.value || needsChannelConfiguration.value || !kw.value.trim() || searchState.value.loading) return;
  if (auth.locked.value && requestUnlock) {
    requestUnlock(doSearch);
    return;
  }
  await doSearch();
}

// 快速搜索
async function quickSearch(keyword: string) {
  kw.value = keyword;
  await onSearch();
}

// 继续搜索（从暂停处继续）
async function handleContinueSearch() {
  if (!searchState.value.paused) return;
  if (auth.locked.value && requestUnlock) {
    requestUnlock(async () => {
      await continueSearch({
        ...getSearchOptions(),
        onAuthRequired: requestUnlock ?? undefined,
      });
    });
    return;
  }
  await continueSearch({
    ...getSearchOptions(),
    onAuthRequired: requestUnlock ?? undefined,
  });
}

// 完全重置 - 清空输入框、结果、状态
async function fullReset() {
  kw.value = "";
  sortType.value = "default";
  filterPlatform.value = "all";
  resetSearch();
  await nextTick();
  if (hotSearchRef.value) await hotSearchRef.value.refresh();
}

const CLOUD_TYPE_LABELS: Record<string, string> = {
  baidu: "百度网盘",
  quark: "夸克网盘",
  aliyun: "阿里云盘",
  mobile: "中国移动云盘",
  tianyi: "天翼云盘",
  "115": "115网盘",
  "123": "123云盘",
  jianguoyun: "坚果云",
  lanzou: "蓝奏云",
  xunlei: "迅雷云盘",
  magnet: "磁力链接",
  others: "其他",
};
const platformName = (type?: string): string => CLOUD_TYPE_LABELS[type || "others"] || type || "其他";

// 网盘类型只作为前端筛选标签，不再拆分成多个结果分组。
const platforms = computed(() => {
  const seen = new Set<string>();
  for (const item of searchState.value.results) for (const type of item.cloud_types) seen.add(type);
  return [...seen];
});

function handlePlatformFilter(type: string) {
  filterPlatform.value = filterPlatform.value === type ? "all" : type;
}

// 先筛选再进行全局排序，保证结果始终以单一列表平铺展示。
const filteredResults = computed(() => {
  const items = filterPlatform.value === "all"
    ? searchState.value.results
    : searchState.value.results.filter((item) => item.cloud_types.includes(filterPlatform.value as any));
  return sortItems(items);
});

function sortItems(items: NormalizedSearchResult[]) {
  const arr = [...items];
  switch (sortType.value) {
    case "date-desc":
      return arr.sort(
        (a, b) =>
          new Date(b.datetime || "1970-01-01").getTime() -
          new Date(a.datetime || "1970-01-01").getTime()
      );
    case "date-asc":
      return arr.sort(
        (a, b) =>
          new Date(a.datetime || "1970-01-01").getTime() -
          new Date(b.datetime || "1970-01-01").getTime()
      );
    case "name-asc":
      return arr.sort((a, b) =>
        String(a.name || "").localeCompare(String(b.name || ""), "zh-CN")
      );
    case "name-desc":
      return arr.sort((a, b) =>
        String(b.name || "").localeCompare(String(a.name || ""), "zh-CN")
      );
    default:
      return arr;
  }
}
</script>

<style scoped>
.search-workspace { display: flex; flex-direction: column; gap: 18px; padding: 20px; border: 1px solid var(--border-light); border-radius: 24px; background: var(--bg-primary); box-shadow: var(--shadow-sm); }
.search-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.manage-channels { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; border: 0; border-radius: 8px; padding: 0 10px; background: transparent; color: var(--primary); font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; }
.manage-channels span { font-size: 20px; font-weight: 400; }
.manage-channels:hover { background: var(--primary-soft); }
.manage-channels:focus-visible, .channel-preview button:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.channel-configuration-status:empty, .scope-summary:empty { display: none; }
.channel-configuration-notice { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px 16px; padding: 14px 16px; border: 1px solid var(--border-light); border-radius: 12px; background: var(--bg-secondary); }
.channel-configuration-notice strong { color: var(--text-primary); font-size: 14px; font-weight: 600; }
.channel-configuration-notice p { margin: 4px 0 0; color: var(--text-secondary); font-size: 13px; line-height: 1.6; }
.configure-channels { min-height: 44px; padding: 0 14px; border: 1px solid var(--border-light); border-radius: 8px; background: var(--bg-primary); color: var(--primary); font-size: 13px; font-weight: 600; white-space: nowrap; cursor: pointer; }
.configure-channels:hover { background: var(--primary-soft); }
.configure-channels:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.scope-summary { color: var(--text-secondary); font-size: 12px; line-height: 1.8; }
.scope-summary p { margin: 0; }
.channel-preview { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.channel-chip { max-width: 100%; overflow-wrap: anywhere; padding: 3px 9px; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 6px; color: var(--text-secondary); }
.channel-preview button { border: 0; color: var(--primary); background: transparent; cursor: pointer; }
.search-notice { margin: 0; padding: 12px 16px; font-size: 13px; line-height: 1.7; color: var(--text-secondary); background: var(--bg-secondary); border-radius: 10px; }
.search-workspace :deep(.search-box) { box-shadow: none; background: var(--bg-secondary); border-radius: 14px; }
.search-workspace :deep(.search-box.focused) { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
@media (max-width: 480px) {
  .search-workspace { padding: 14px; gap: 14px; border-radius: 18px; }
  .search-toolbar { flex-wrap: wrap; gap: 6px; }
  .search-toolbar :deep(.scope-control) { flex: 1; }
  .manage-channels { margin-left: auto; }
}

.home {
  width: 100%;
  max-width: 760px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

/* 大标题 */
.hero {
  text-align: center;
  padding: 56px 16px 8px;
}

.hero-title {
  font-size: clamp(28px, 5vw, 42px);
  font-weight: 800;
  margin: 0 0 12px;
  color: var(--text-primary);
  letter-spacing: -0.02em;
  line-height: 1.2;
}

.hero-description {
  font-size: 14px;
  color: var(--text-tertiary);
  margin: 0;
  line-height: 1.65;
}

/* 热门搜索 */
.hot-search-section {
  animation: fadeIn 0.5s ease;
}

/* 统计和过滤器栏 */
.stats-bar {
  background: var(--bg-primary);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
  padding: 16px;
  box-shadow: var(--shadow-sm);
  animation: fadeIn 0.4s ease;
}

.stats-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.stats-main {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.stat-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
}

.stat-label {
  font-size: 13px;
  color: var(--text-tertiary);
  font-weight: 500;
}

.stat-value {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

/* 加载指示器 */
.loading-indicator {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--primary-soft);
  border-radius: 999px;
}

.pulse-dot {
  width: 8px;
  height: 8px;
  background: var(--primary);
  border-radius: 50%;
  animation: pulse 1.5s ease-in-out infinite;
}

.loading-text {
  font-size: 13px;
  color: var(--primary);
  font-weight: 500;
}

/* 暂停状态指示器（统计栏） */
.paused-indicator-bar {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(245, 158, 11, 0.1);
  border-radius: 999px;
  color: #b45309;
  font-weight: 500;
}

.pause-icon {
  font-size: 14px;
}

.paused-text {
  font-size: 13px;
}

/* 平台过滤器 */
.platform-filters {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}

.filter-pill {
  padding: 7px 14px;
  border: 1px solid var(--border-light);
  background: var(--bg-primary);
  border-radius: 999px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background-color var(--transition-fast), border-color var(--transition-fast),
    color var(--transition-fast);
  white-space: nowrap;
}

.filter-pill:hover {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.filter-pill.active {
  background: var(--primary-soft);
  color: var(--primary);
  border-color: transparent;
  font-weight: 600;
}

/* 排序选择器 */
.sorter {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sort-select {
  padding: 8px 12px;
  border: 1px solid var(--border-light);
  background: var(--bg-primary);
  border-radius: 999px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  cursor: pointer;
  transition: border-color var(--transition-fast);
  min-width: 140px;
}

.sort-select:hover {
  border-color: var(--border-medium);
}

.sort-select:focus {
  outline: none;
  border-color: var(--primary);
}

/* 搜索结果区域 */
.results-section {
  animation: fadeIn 0.5s ease;
}

.results-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
}

/* 空状态 */
.empty-state {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 48px 24px;
  animation: fadeIn 0.4s ease;
}

.empty-card {
  background: var(--bg-primary);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-xl);
  padding: 32px;
  text-align: center;
  max-width: 400px;
  box-shadow: var(--shadow-sm);
}

.empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
  opacity: 0.6;
}

.empty-card h3 {
  margin: 0 0 8px 0;
  font-size: 20px;
  color: var(--text-primary);
}

.empty-card p {
  margin: 0;
  font-size: 14px;
  color: var(--text-secondary);
  line-height: 1.6;
}

/* 错误提示 */
.error-alert {
  display: flex;
  align-items: center;
  gap: 12px;
  background: rgba(239, 68, 68, 0.06);
  border: 1px solid rgba(239, 68, 68, 0.25);
  border-radius: var(--radius-md);
  padding: 12px 16px;
  color: var(--error);
  font-weight: 500;
  animation: fadeIn 0.3s ease;
}

.error-icon {
  font-size: 18px;
}

/* 移动端优化 */
@media (max-width: 640px) {
  .hero {
    padding: 32px 8px 4px;
  }

  .stats-bar {
    padding: 12px;
  }

  .stats-main {
    gap: 8px;
  }

  .stat-item {
    padding: 6px 10px;
  }

  .stat-value {
    font-size: 16px;
  }

  .platform-filters {
    gap: 6px;
  }

  .filter-pill {
    padding: 5px 10px;
    font-size: 12px;
  }

  .sort-select {
    min-width: 120px;
    font-size: 12px;
  }

  .empty-card {
    padding: 24px;
  }

  .empty-icon {
    font-size: 36px;
  }

  .empty-card h3 {
    font-size: 18px;
  }
}

/* 深色模式支持 */
@media (prefers-color-scheme: dark) {
  .paused-indicator-bar {
    background: rgba(245, 158, 11, 0.15);
    color: #fbbf24;
  }

  .error-alert {
    background: rgba(239, 68, 68, 0.12);
    border-color: rgba(239, 68, 68, 0.35);
  }
}

/* 高对比度模式支持 */
@media (prefers-contrast: high) {
  .filter-pill.active {
    border-width: 2px;
  }

  .sort-select {
    border-width: 2px;
  }
}

/* 减少动画模式支持 */
@media (prefers-reduced-motion: reduce) {
  .stats-bar,
  .results-section,
  .empty-state,
  .error-alert,
  .hot-search-section {
    animation: none;
  }

  .pulse-dot {
    animation: none;
    opacity: 0.7;
  }
}
</style>
