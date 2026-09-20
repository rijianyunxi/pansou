<template>
  <div class="home">
    <!-- 简洁大标题 -->
    <header class="hero">
      <h1 class="hero-title">{{ homeTitle }}</h1>
      <p class="hero-description">{{ homeDescription }}</p>
    </header>

    <HomeSearchWorkspace
      :only-user-channels="onlyUserChannels"
      :channel-count="settings.userChannels.length"
      :channels="settings.userChannels"
      :search-scope-disabled="searchScopeDisabled"
      :custom-channels-disabled="!canUseCustomChannels"
      :keyword="kw"
      :loading="searchState.loading"
      :paused="searchState.paused"
      :searched="searched"
      :search-disabled="!settingsReady || !auth.sessionReady.value || needsChannelConfiguration"
      :disabled-description-id="needsChannelConfiguration && !searchState.loading ? 'channel-configuration-hint' : undefined"
      :placeholder="placeholder"
      :needs-channel-configuration="needsChannelConfiguration"
      :storage-error="storageError"
      :session-error="auth.sessionError.value"
      :session-ready="auth.sessionReady.value"
      @update:only-user-channels="onlyUserChannels = $event"
      @update:keyword="kw = $event"
      @custom-disabled="notifyCustomChannelsAccess"
      @open-channels="handleOpenChannelSettings"
      @search="onSearch"
      @reset="fullReset"
      @pause="pauseSearch"
      @continue="handleContinueSearch" />

    <!-- 热门搜索：仅未搜索时展示 -->
    <div v-if="auth.sessionReady.value && auth.showHotSearch.value" v-show="!searched" class="hot-search-section">
      <HotSearchSection ref="hotSearchRef" :on-search="quickSearch" />
    </div>

    <HomeResultsPanel
      :searched="searched"
      :total="searchState.total"
      :elapsed-ms="searchState.elapsedMs"
      :paused="searchState.paused"
      :loading="searchState.loading"
      :error="searchState.error"
      :has-results="hasResults"
      :platforms="platforms"
      :platform-counts="platformCounts"
      :filter-platform="filterPlatform"
      :sort-type="sortType"
      :filtered-results="filteredResults"
      :platform-label="platformName"
      :show-back-to-top="showBackToTop"
      @update:filter-platform="filterPlatform = $event"
      @update:sort-type="sortType = $event"
      @filter-platform="handlePlatformFilter"
      @copy="captureResource"
      @open="captureResource"
      @apply-time-sort="applyTimeSort"
      @scroll-to-top="scrollToTop" />
  </div>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { CLOUD_TYPE_LABELS } from "~/shared/cloudTypes";
import { DEFAULT_HOME_SEARCH_PLACEHOLDER } from "~/shared/homeSearch";
import type { SearchResult } from "~/server/core/types/models";

const config = useRuntimeConfig();
const publicConfig = config.public as Record<string, unknown>;
function publicText(key: string): string {
  const value = publicConfig[key];
  return typeof value === "string" ? value : "";
}

const apiBase = publicText("apiBase") || "/api";
const siteUrl = publicText("siteUrl").replace(/\/+$/, "");
const siteName = publicText("siteName");
const homeTitle = publicText("homeTitle");
const homeDescription = publicText("homeDescription");
const siteTitle = publicText("siteTitle");
const siteImageAlt = publicText("siteImageAlt");
const route = useRoute();

// 热搜组件引用
const hotSearchRef = ref<{ init: () => Promise<void> } | null>(null);

// 页面加载时初始化热搜数据
const showBackToTop = ref(false);

let scrollFrame: number | undefined;
function updateScrollState() {
  if (scrollFrame !== undefined) return;
  scrollFrame = window.requestAnimationFrame(() => {
    scrollFrame = undefined;
    showBackToTop.value = window.scrollY > 360;
  });
}

function scrollToTop() {
  window.scrollTo({ top: 0, behavior: "smooth" });
}

onMounted(async () => {
  window.addEventListener("scroll", updateScrollState, { passive: true });
  updateScrollState();
  // Support the SearchAction URL emitted below, e.g. /?q=movie.
  const queryKeyword = typeof route.query.q === "string" ? route.query.q.trim() : "";
  await auth.initializeSession();
  await nextTick();
  // 热搜展示受后台策略控制；先完成会话配置，再决定是否请求热搜数据。
  const hotSearchPromise = queryKeyword || !auth.showHotSearch.value ? undefined : hotSearchRef.value?.init();
  await Promise.all([
    settingsApi.syncWithSession(),
    hotSearchPromise,
  ]);
  if (queryKeyword) {
    kw.value = queryKeyword;
    await onSearch();
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("scroll", updateScrollState);
  if (scrollFrame !== undefined) {
    window.cancelAnimationFrame(scrollFrame);
    scrollFrame = undefined;
  }
});

// Resolve public SEO values at runtime so the same build can use different environments.
useSeoMeta({
  title: siteTitle || homeTitle,
  description: publicText("siteDescription"),
  keywords: publicText("siteKeywords"),
  ogTitle: siteTitle,
  ogDescription: publicText("siteDescription"),
  ogSiteName: siteName,
  ogImageAlt: siteImageAlt,
  ogUrl: siteUrl ? `${siteUrl}/` : undefined,
  ogImage: siteUrl ? `${siteUrl}/og.svg` : undefined,
  twitterImage: siteUrl ? `${siteUrl}/og.svg` : undefined,
});

useHead({
  link: siteUrl ? [{ rel: "canonical", href: `${siteUrl}/` }] : [],
  script: siteUrl ? [
    {
      type: "application/ld+json",
      innerHTML: JSON.stringify({
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: siteName,
        description: publicText("siteDescription"),
        inLanguage: "zh-CN",
        url: `${siteUrl}/`,
        potentialAction: {
          "@type": "SearchAction",
          target: `${siteUrl}/?q={search_term_string}`,
          "query-input": "required name=search_term_string",
        },
      }),
    },
  ] : [],
});

// 搜索相关状态
const kw = ref("");
// Search scope is per visit, never a persisted channel preference.
const onlyUserChannels = ref(false);
const placeholder = computed(() => auth.homeSearchPlaceholder.value || DEFAULT_HOME_SEARCH_PLACEHOLDER);

// 排序和过滤
const sortType = ref<"default" | "date-desc" | "date-asc">("default");
const filterPlatform = ref<string>("all");

// 使用搜索 composable
const {
  state: searchState,
  searched,
  performSearch,
  resetSearch,
  captureResource,
  pauseSearch,
  continueSearch,
  hasResults,
} = useSearch();
const settingsApi = useSettings();
const { settings, settingsReady, storageError } = settingsApi;
const auth = useAuth();
const searchScopeDisabled = computed(() =>
  searchState.value.loading || searchState.value.paused || !settingsReady.value || !auth.sessionReady.value,
);
const canUseCustomChannels = computed(() => !!auth.user.value || auth.anonymousCustomChannels.value);
const needsChannelConfiguration = computed(() => onlyUserChannels.value && settings.value.userChannels.length === 0);
const openChannelSettings = inject<() => void>("openChannelSettings", () => {});
const showToast = inject<(message: string, type?: "info" | "success" | "error") => void>("showToast", () => {});
function handleOpenChannelSettings() {
  if (searchState.value.paused) {
    showToast("当前搜索已暂停，搜索范围将在下一次搜索时生效。", "info");
    return;
  }
  openChannelSettings();
}
function notifyCustomChannelsAccess() {
  showToast("自定义频道需要在微信小程序中登录后使用，或由管理员开启「允许匿名用户使用自定义频道」。", "info");
}
watch(canUseCustomChannels, (allowed) => {
  if (!allowed && onlyUserChannels.value) onlyUserChannels.value = false;
});

// 获取搜索选项（用户自定义频道实时读取最新设置）
function getSearchOptions() {
  return {
    apiBase,
    keyword: kw.value,
    userChannels: settings.value.userChannels,
    onlyUserChannels: onlyUserChannels.value,
  };
}

// 执行实际搜索逻辑
async function doSearch() {
  if (!settingsReady.value || !auth.sessionReady.value || needsChannelConfiguration.value || !kw.value.trim() || searchState.value.loading) return;
  const keyword = kw.value.trim();
  // 新搜索从全量结果视图开始，避免沿用上一次平台筛选状态。
  filterPlatform.value = "all";
  await performSearch({
    ...getSearchOptions(),
    onSessionExpired: () => { if (auth.user.value) { auth.handleSessionExpired(); void settingsApi.syncWithSession(); } },
  });
}

// 搜索执行
async function onSearch() {
  if (!settingsReady.value || !auth.sessionReady.value || needsChannelConfiguration.value || !kw.value.trim() || searchState.value.loading) return;
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
  await continueSearch();
}

// 完全重置 - 清空输入框、结果、状态
function fullReset() {
  kw.value = "";
  sortType.value = "default";
  filterPlatform.value = "all";
  resetSearch();
  // 热搜组件常驻但默认只初始化一次，避免每次重置搜索都重新读 SQLite。
  void hotSearchRef.value?.init();
}

const platformName = (type?: string): string => CLOUD_TYPE_LABELS[type || "others"] || type || "其他";

// 网盘类型只作为前端筛选标签，不再拆分成多个结果分组。
const platforms = computed(() => {
  const seen = new Set<string>();
  for (const item of searchState.value.results) for (const type of item.cloud_types) seen.add(type);
  return [...seen];
});

// A resource can contain more than one kind of share link, so count each
// resource once under every cloud type it exposes. This keeps the numbers
// aligned with the result cards and with the platform filters.
const platformCounts = computed<Record<string, number>>(() => {
  const counts: Record<string, number> = {};
  for (const item of searchState.value.results) {
    for (const type of new Set(item.cloud_types)) counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
});

function handlePlatformFilter(type: string) {
  filterPlatform.value = filterPlatform.value === type ? "all" : type;
}

function applyTimeSort() {
  sortType.value = "date-desc";
}

// 先筛选再进行全局排序，保证结果始终以单一列表平铺展示。
const filteredResults = computed(() => {
  const items = filterPlatform.value === "all"
    ? searchState.value.results
    : searchState.value.results.filter((item) => item.cloud_types.includes(filterPlatform.value as any));
  // 流式返回期间始终保持到达顺序；搜索完成后仅在用户选择了排序方式时整理一次。
  return searchState.value.loading || searchState.value.paused ? items : sortItems(items);
});

function parseSearchDate(value: string | null): number {
  const raw = value?.trim() || "";
  if (!raw) return 0;

  // Search dates are formatted by the server in Asia/Shanghai. Parse that
  // explicit offset instead of relying on browser-specific local-time parsing.
  const match = /^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw);
  if (match) {
    const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
    const timestamp = Date.parse(
      `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}T${hour!.padStart(2, "0")}:${minute}:${second}+08:00`,
    );
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sortItems(items: SearchResult[]) {
  const arr = [...items];
  if (sortType.value === "default") return arr;
  return sortType.value === "date-asc"
    ? arr.sort((a, b) => parseSearchDate(a.datetime) - parseSearchDate(b.datetime))
    : arr.sort((a, b) => parseSearchDate(b.datetime) - parseSearchDate(a.datetime));
}
</script>

<style scoped>
.home {
  width: 100%;
  max-width: 760px;
  min-width: 0;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.hero {
  position: relative;
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

.hot-search-section {
  animation: fadeIn 0.5s ease;
}

@media (max-width: 640px) {
  .hero {
    padding: 32px 8px 4px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .hot-search-section {
    animation: none;
  }
}
</style>
