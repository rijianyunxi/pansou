<template>
  <div class="home" :class="{ 'home--searched': searched }">
    <header v-if="!searched" class="hero">
      <div class="hero-copy">
        <span class="hero-eyebrow">你的资源发现入口 <span aria-hidden="true">—</span></span>
        <h1 v-if="homeTitle === '网盘资源聚合搜索'" class="hero-title">想找的，<br><em>都在这里。</em></h1>
        <h1 v-else class="hero-title hero-title--custom">{{ homeTitle }}</h1>
        <p class="hero-description">{{ homeDescription }}</p>
      </div>
      <img class="hero-art" :src="discoveryHeroSvg" alt="" width="720" height="480" fetchpriority="high" />
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

    <section v-if="!searched && searchHistory.length" class="search-history" aria-label="搜索历史">
      <header><h2>最近搜过</h2><button type="button" @click="changeHistory('clear')">清空记录</button></header>
      <div class="history-list"><span v-for="term in searchHistory" :key="term" class="history-chip"><button type="button" @click="quickSearch(term)">{{ term }}</button><button type="button" class="history-remove" :aria-label="`删除搜索记录：${term}`" @click="changeHistory('remove', term)">×</button></span></div>
    </section>

    <!-- 热门搜索：仅未搜索时展示 -->
    <div v-if="auth.sessionReady.value && auth.showHotSearch.value" v-show="!searched" class="hot-search-section">
      <HotSearchSection ref="hotSearchRef" :on-search="quickSearch" />
    </div>


    <HomeResultsPanel
      :searched="searched"
      :keyword="submittedKeyword"
      :total="displayResults.length"
      :elapsed-ms="searchState.elapsedMs"
      :paused="searchState.paused"
      :loading="searchState.loading"
      :error="searchState.error"
      :has-results="displayResults.length > 0"
      :platforms="platforms"
      :platform-counts="platformCounts"
      :filter-platform="filterPlatform"
      :sort-type="sortType"
      :filtered-results="filteredResults"
      :platform-label="platformName"
      :show-back-to-top="showBackToTop"
      @update:filter-platform="filterPlatform = $event"
      @update:sort-type="sortType = $event"
      @apply-time-sort="applyTimeSort"
      @scroll-to-top="scrollToTop" />
  </div>
</template>

<script setup lang="ts">
import { createHistory } from "../../utils/searchHistory.js";
import { useRoute } from "vue-router";
import { appConfig, setDocumentHead } from "../../src/appRuntime";
import { useAuth } from "../../composables/useAuth";
import { useSearch } from "../../composables/useSearch";
import { useSettings } from "../../composables/useSettings";
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { CLOUD_TYPE_LABELS, sortCloudTypes } from "~/shared/cloudTypes";
import { DEFAULT_HOME_SEARCH_PLACEHOLDER } from "~/shared/homeSearch";
import { flattenResultsForDisplay, type DisplaySearchResult } from "~/utils/resultDisplay";
import discoveryHeroSvg from "~/assets/discovery-hero.svg";

import HomeResultsPanel from "../../components/home/HomeResultsPanel.vue";
import HomeSearchWorkspace from "../../components/home/HomeSearchWorkspace.vue";
import HotSearchSection from "../../components/HotSearchSection.vue";

import type { SearchResult } from "~/shared/apiModels";

function publicText(key: keyof typeof appConfig): string {
  return appConfig[key];
}

const apiBase = publicText("apiBase") || "/api";
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
  reloadHistory();
  window.addEventListener("storage", reloadHistory);
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
  window.removeEventListener("storage", reloadHistory);
  window.removeEventListener("scroll", updateScrollState);
  if (scrollFrame !== undefined) {
    window.cancelAnimationFrame(scrollFrame);
    scrollFrame = undefined;
  }
});

setDocumentHead({
  title: siteTitle || homeTitle,
  meta: [
    { name: "description", content: publicText("siteDescription") },
    { name: "keywords", content: publicText("siteKeywords") },
    { property: "og:title", content: siteTitle },
    { property: "og:description", content: publicText("siteDescription") },
    { property: "og:site_name", content: siteName },
    { property: "og:image:alt", content: siteImageAlt },
  ],
});


// 搜索相关状态
const searchHistory = ref<string[]>([]);
const historyStore = createHistory({ getItem: key => window.localStorage.getItem(key), setItem: (key, value) => window.localStorage.setItem(key, value), removeItem: key => window.localStorage.removeItem(key) });
function reloadHistory() { searchHistory.value = historyStore.read(); }
function changeHistory(action: 'add' | 'remove' | 'clear', term = '') {
  try { searchHistory.value = action === 'clear' ? historyStore.clear() : historyStore[action](term); }
  catch { showToast('无法保存搜索历史，请检查本地存储空间或浏览器设置。', 'error'); }
}
const kw = ref("");
const submittedKeyword = ref("");
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
  pauseSearch,
  continueSearch,
} = useSearch();
const settingsApi = useSettings();
const { settings, settingsReady, storageError } = settingsApi;
const auth = useAuth();
const searchScopeDisabled = computed(() =>
  searchState.value.loading || searchState.value.paused || !settingsReady.value || !auth.sessionReady.value,
);
const canUseCustomChannels = computed(() => !!auth.user.value || auth.anonymousCustomChannels.value);
const needsChannelConfiguration = computed(() => onlyUserChannels.value && settings.value.userChannels.length === 0);
const displayResults = computed<DisplaySearchResult[]>(() => flattenResultsForDisplay(searchState.value.results));
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
  showToast("未登录不可使用", "info");
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
  submittedKeyword.value = keyword;
  changeHistory("add", keyword);
  // 新搜索从全量结果视图开始，避免沿用上一次平台筛选状态。
  filterPlatform.value = "all";
  await performSearch({
    ...getSearchOptions(),
    onSessionExpired: async () => {
      auth.handleSessionExpired("搜索会话已失效，正在重新建立匿名会话。");
      await auth.initializeSession(true);
      await settingsApi.syncWithSession();
    },
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
  // 热搜组件常驻但默认只初始化一次，避免每次重置搜索都重新读 PostgreSQL。
  void hotSearchRef.value?.init();
}

const platformName = (type?: string): string => CLOUD_TYPE_LABELS[type || "others"] || type || "其他";

// 数据仍按资源合并，展示时按单个分享链接展开。
const platforms = computed(() => {
  const seen = new Set<string>();
  for (const item of displayResults.value) for (const type of item.cloud_types) seen.add(type);
  return sortCloudTypes([...seen]);
});

const platformCounts = computed<Record<string, number>>(() => {
  const counts: Record<string, number> = {};
  for (const item of displayResults.value) {
    for (const type of new Set(item.cloud_types)) counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
});

function applyTimeSort() {
  sortType.value = "date-desc";
}

// 先筛选再进行全局排序，保证结果始终以单一列表平铺展示。
const filteredResults = computed(() => {
  const items = filterPlatform.value === "all"
    ? displayResults.value
    : displayResults.value.filter((item) => item.cloud_types.includes(filterPlatform.value as any));
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

function sortItems<T extends SearchResult>(items: T[]): T[] {
  const arr = [...items];
  if (sortType.value === "default") return arr;
  return sortType.value === "date-asc"
    ? arr.sort((a, b) => parseSearchDate(a.datetime) - parseSearchDate(b.datetime))
    : arr.sort((a, b) => parseSearchDate(b.datetime) - parseSearchDate(a.datetime));
}
</script>

<style scoped>

.home { width: 100%; max-width: 1120px; margin: 0 auto; display: flex; flex-direction: column; gap: 28px; }
.hero { display: grid; grid-template-columns: 1fr 1.15fr; align-items: center; position: relative; min-height: 310px; }
.hero-copy { position: relative; z-index: 1; padding: 20px 0 24px 16px; }
.hero-eyebrow { color: var(--primary); font-size: 13px; font-weight: 650; display: flex; align-items: center; gap: 12px; }
.hero-title { font-size: clamp(42px, 4.7vw, 68px); font-weight: 900; line-height: 1.18; letter-spacing: -.055em; margin: 16px 0; color: #191916; }
.hero-title em { font-style: normal; color: #ff5b18; }
.hero-title--custom { font-size: clamp(32px, 4vw, 52px); }
.hero-description { color: #77756f; font-size: 16px; line-height: 1.8; margin: 0; }
.hero-art { width: 100%; height: 330px; object-fit: contain; }
.home:not(.home--searched) > :deep(.search-workspace) { margin: -38px 12px 0; position: relative; z-index: 2; box-shadow: 3px 4px 0 #ff814c, 0 10px 25px #67401a06; }
.home--searched { gap: 24px; }
.home--searched > :deep(.search-workspace) { padding: 0; background: transparent; border: 0; border-radius: 0; box-shadow: none; }
.discovery-note { text-align: center; margin: 0; color: var(--text-tertiary); font-size: 12px; letter-spacing: 2px; }
@media(max-width:640px) { .home { gap: 24px; } .hero { min-height: 240px; grid-template-columns: 1fr; overflow: hidden; } .hero-copy { padding: 14px 8px 40px; } .hero-title { font-size: 44px; } .hero-description { max-width: 250px; font-size: 13px; } .hero-art { position: absolute; right: -65px; bottom: 0; width: 235px; height: 235px; opacity: .28; } .home:not(.home--searched) > :deep(.search-workspace) { margin: -25px 0 0; } }


.search-history { padding: 0 12px; }
.search-history header { display: flex; align-items: center; justify-content: space-between; }
.search-history h2 { font-size: 17px; margin: 0; }
.search-history button { background: transparent; border: 0; color: var(--text-secondary); cursor: pointer; min-height: 44px; font-size: 12px; }
.search-history button:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.history-list { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.history-chip { display: inline-flex; max-width: 100%; align-items: center; border-radius: 8px; background: #faf2e7; }
.history-chip button:first-child { padding: 0 4px 0 12px; overflow-wrap: anywhere; text-align: left; }
.history-chip .history-remove { min-width: 44px; font-size: 18px; }
.search-history p { margin: 8px 0 0; color: var(--text-tertiary); font-size: 11px; }
</style>
