<template>
    <div v-if="searched" class="stats-bar">
      <div class="stats-content">
        <div class="stats-main" aria-live="polite">
          <h2>{{ keyword }}</h2>
          <span class="result-summary">本次已加载 <strong>{{ resourceTotal ?? total }}</strong> 条资源 · 用时 {{ (elapsedMs / 1000).toFixed(1) }} 秒</span>
          <span class="search-status" :class="{ 'is-loading': loading, 'is-paused': paused, 'is-error': error }"><i></i>{{ error ? '搜索异常' : paused ? '搜索已暂停' : loading ? '正在搜索…' : hasMore ? '还有更多结果' : '搜索完成' }}</span>
        </div>

        <div class="platform-filters" v-if="platforms.length">
          <button
            :class="['filter-pill', { active: filterPlatform === 'all' }]"
            :aria-pressed="filterPlatform === 'all'"
            @click="emit('update:filterPlatform', 'all')">
            <span>全部资源</span><span class="platform-count">{{ total }}</span>
          </button>
          <button
            v-for="platform in platforms"
            :key="platform"
            :class="['filter-pill', { active: filterPlatform === platform }]"
            :aria-pressed="filterPlatform === platform"
            @click="emit('update:filterPlatform', platform)">
            <span>{{ platformLabel(platform) }}</span><span class="platform-count">{{ platformCounts[platform] || 0 }}</span>
          </button>
        </div>

        <p v-if="platforms.length" class="platform-count-hint">网盘只筛选已加载结果，每次搜索最多 200 条资源</p>
        <div v-if="hasResults" class="sort-options" role="group" aria-label="排序方式">
          <button v-for="option in sortOptions" :key="option.value" type="button"
            :class="['sort-option', { active: sortType === option.value }]"
            :aria-pressed="sortType === option.value"
            @click="emit('update:sortType', option.value)">{{ option.label }}</button>
        </div>
      </div>
    </div>

    <section v-if="hasResults" class="results-section">
      <div class="results-grid">
        <ResultGroup
          title="搜索结果"
          color="#9ca3af"
          icon="📦"
          :items="filteredResults"
          :keyword="keyword"
          :expanded="true"
          :initial-visible="0"
          :show-header="false"
          :platform-label="platformLabel"
          />
      </div>
      <p class="results-footer">已展示 {{ filteredResults.length }} 条网盘链接<template v-if="serverPagination && !hasMore && !loading && !paused && !error && filterPlatform !== 'all'"> · 本次搜索结果加载完成</template></p>
    </section>

    <section v-else-if="searched && !error && !loading && !paused" class="empty-state">
      <div class="empty-card">
        <div class="empty-icon">🔍</div>
        <h3>{{ filterPlatform === 'all' ? '未找到相关资源' : '当前网盘暂无结果' }}</h3>
        <p>{{ filterPlatform === 'all' ? '试试其他关键词，或检查设置中的搜索来源是否已开启' : '切换其他网盘，或尝试其他关键词' }}</p>
      </div>
    </section>

    <section v-if="searched && loading && !hasResults" class="search-loading" role="status"><span class="search-loading-dot"></span><h3>正在寻找相关资源</h3><p>结果会陆续出现在这里，你可以随时暂停搜索。</p></section>
    <section v-if="searched && paused && !hasResults" class="search-loading" role="status"><h3>搜索已暂停</h3><p>点击搜索框中的继续按钮，接着寻找资源。</p></section>
    <section v-if="hasResults && filteredResults.length === 0" class="search-loading" role="status"><h3>当前网盘暂无结果</h3><p>选择其他网盘，或查看全部资源。</p></section>

    <section v-if="error" class="error-alert">
      <span class="error-icon">⚠️</span>
      <span>{{ error }}</span>
    </section>

    <div v-if="hasResults || showBackToTop" class="floating-tools" aria-label="页面工具">
      <button
        v-if="showBackToTop"
        class="back-to-top"
        type="button"
        aria-label="一键回到顶部"
        title="回到顶部"
        @click="emit('scroll-to-top')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">
          <path d="M12 19V5"></path>
          <path d="m6 11 6-6 6 6"></path>
        </svg>
      </button>
    </div>
</template>

<script setup lang="ts">
import ResultGroup from "../ResultGroup.vue";
import type { DisplaySearchResult } from "~/utils/resultDisplay";

type SortType = "default" | "date-desc" | "date-asc";

interface Props {
  searched: boolean;
  keyword: string;
  total: number;
  resourceTotal?: number;
  elapsedMs: number;
  paused: boolean;
  loading: boolean;
  error: string;
  hasResults: boolean;
  hasMore?: boolean;
  serverPagination?: boolean;
  platforms: string[];
  platformCounts: Record<string, number>;
  filterPlatform: string;
  sortType: SortType;
  filteredResults: DisplaySearchResult[];
  platformLabel: (type?: string) => string;
  showBackToTop: boolean;
}

defineProps<Props>();
const emit = defineEmits<{
  (event: "update:filterPlatform", value: string): void;
  (event: "update:sortType", value: SortType): void;
  (event: "apply-time-sort"): void;
  (event: "scroll-to-top"): void;
}>();

const sortOptions: { value: SortType; label: string }[] = [
  { value: 'default', label: '默认顺序' },
  { value: 'date-desc', label: '最新发布' },
  { value: 'date-asc', label: '最早发布' },
];

</script>

<style scoped>
.stats-bar { background: var(--bg-primary); border: 1px solid var(--border-light); border-radius: var(--radius-lg); padding: 16px; box-shadow: var(--shadow-sm); animation: fadeIn 0.4s ease; }
.stats-content { display: flex; flex-direction: column; gap: 10px; }
.platform-count-hint { flex: 1 0 100%; color: var(--text-tertiary); font-size: 12px; line-height: 1.5; }
.stats-main { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.stat-item { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--bg-secondary); border-radius: var(--radius-md); }
.stat-label { font-size: 13px; color: var(--text-tertiary); font-weight: 500; }
.stat-value { font-size: 18px; font-weight: 700; color: var(--text-primary); font-variant-numeric: tabular-nums; }
.paused-indicator-bar { display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; background: rgba(245, 158, 11, 0.1); border-radius: 999px; color: #b45309; font-weight: 500; }
.pause-icon { font-size: 14px; }
.paused-text { font-size: 13px; }
.platform-filters { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.filter-pill { position: relative; display: inline-flex; align-items: center; gap: 7px; min-height: 32px; padding: 5px 12px; line-height: 20px; border: 1px solid var(--border-light); background: var(--bg-primary); border-radius: 8px; font-size: 13px; font-weight: 500; color: var(--text-secondary); cursor: pointer; transition: background-color var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast); white-space: nowrap; }
.filter-pill:focus-visible, .sort-option:focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; }
.filter-pill:hover { background: var(--bg-secondary); color: var(--text-primary); }
.filter-pill.active { background: var(--primary-soft); color: var(--primary); border-color: transparent; font-weight: 600; }
.platform-count { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 999px; background: var(--bg-secondary); color: var(--text-tertiary); font-size: 11px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; }
.filter-pill.active .platform-count { background: rgba(37, 99, 235, 0.14); color: var(--primary); }
.floating-tools { position: fixed; right: 24px; bottom: max(24px, env(safe-area-inset-bottom)); z-index: 40; display: flex; flex-direction: column; gap: 8px; }
.floating-sort-button, .back-to-top { display: flex; align-items: center; justify-content: center; gap: 6px; width: 44px; height: 44px; min-height: 44px; padding: 0; border: 1px solid var(--border-light); border-radius: 12px; background: color-mix(in srgb, var(--bg-primary) 92%, transparent); color: var(--primary); box-shadow: var(--shadow-lg); backdrop-filter: blur(12px); font-size: 12px; font-weight: 700; cursor: pointer; transition: border-color var(--transition-fast), background-color var(--transition-fast), transform var(--transition-fast); }
.floating-sort-button svg, .back-to-top svg { width: 18px; height: 18px; }
.floating-sort-button:hover, .back-to-top:hover { border-color: var(--primary); background: var(--primary-soft); }
.floating-sort-button:active, .back-to-top:active { transform: translateY(1px); }
.results-section { width: 100%; max-width: 100%; min-width: 0; animation: fadeIn 0.5s ease; }
.results-grid { display: grid; grid-template-columns: minmax(0, 1fr); width: 100%; max-width: 100%; min-width: 0; gap: 16px; }
.empty-state { display: flex; justify-content: center; align-items: center; padding: 48px 24px; animation: fadeIn 0.4s ease; }
.empty-card { background: var(--bg-primary); border: 1px solid var(--border-light); border-radius: var(--radius-xl); padding: 32px; text-align: center; max-width: 400px; box-shadow: var(--shadow-sm); }
.empty-icon { font-size: 48px; margin-bottom: 16px; opacity: 0.6; }
.empty-card h3 { margin: 0 0 8px 0; font-size: 20px; color: var(--text-primary); }
.empty-card p { margin: 0; font-size: 14px; color: var(--text-secondary); line-height: 1.6; }
.error-alert { display: flex; align-items: center; gap: 12px; background: rgba(239, 68, 68, 0.06); border: 1px solid rgba(239, 68, 68, 0.25); border-radius: var(--radius-md); padding: 12px 16px; color: var(--error); font-weight: 500; animation: fadeIn 0.3s ease; }
.error-icon { font-size: 18px; }
@media (max-width: 640px) {
  .stats-bar { padding: 12px; }
  .stats-main { gap: 8px; }
  .stat-item { padding: 6px 10px; }
  .stat-value { font-size: 16px; }
  .platform-filters { gap: 12px 8px; padding: 6px 0; }
  .filter-pill { min-height: 32px; padding: 5px 10px; font-size: 12px; }
  .filter-pill::after { content: ""; position: absolute; inset: -6px 0; }
  .floating-tools { right: 14px; bottom: max(14px, env(safe-area-inset-bottom)); }
  .floating-sort-button, .back-to-top { width: 44px; height: 44px; min-height: 44px; }
  .empty-card { padding: 24px; }
  .empty-icon { font-size: 36px; }
  .empty-card h3 { font-size: 18px; }
}
@media (prefers-color-scheme: dark) {
  .paused-indicator-bar { background: rgba(245, 158, 11, 0.15); color: #fbbf24; }
  .error-alert { background: rgba(239, 68, 68, 0.12); border-color: rgba(239, 68, 68, 0.35); }
}
@media (prefers-contrast: high) {
  .filter-pill.active { border-width: 2px; }
}
@media (prefers-reduced-motion: reduce) {
  .stats-bar, .results-section, .empty-state, .error-alert { animation: none; }
}

.stats-bar { background: transparent; padding: 0; border: 0; box-shadow: none; }
.stats-content { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; align-items: center; }
.stats-main { grid-column: 1 / -1; gap: 14px; }
.stats-main h2 { margin: 0; font-size: 24px; font-weight: 800; overflow-wrap: anywhere; }
.result-summary { color: var(--text-secondary); font-size: 12px; }
.result-summary strong { font-weight: 500; }
.search-status { display: inline-flex; align-items: center; gap: 7px; margin-left: auto; font-size: 12px; color: var(--text-secondary); }
.search-status i { width: 7px; height: 7px; background: #21af72; border-radius: 50%; }
.search-status.is-loading i, .search-status.is-paused i { background: #f5a623; }
.search-status.is-error i { background: #d94e42; }
.platform-filters { gap: 8px; }
.filter-pill { border-radius: 999px; min-height: 36px; padding: 6px 13px; background: #fff; }
.filter-pill.active { background: var(--primary); color: #fff; }
.platform-count, .filter-pill.active .platform-count { background: transparent; color: inherit; padding: 0; min-width: 10px; font-weight: 500; }
.floating-sort-button { display: none; }
.back-to-top { border-radius: 50%; color: var(--text-secondary); }
.results-footer { text-align: center; font-size: 12px; color: var(--text-tertiary); margin: 15px 0 0; }
.search-loading { padding: 54px 24px; text-align: center; border: 1px solid var(--border-light); border-radius: 14px; background: #fff; }
.search-loading h3 { font-size: 18px; margin: 12px 0; }
.search-loading p { font-size: 13px; color: var(--text-secondary); }
.search-loading-dot { display: inline-block; width: 24px; height: 24px; border: 2px solid #ffe0ce; border-top-color: var(--primary); border-radius: 50%; animation: search-spin .8s linear infinite; }
@keyframes search-spin { to { transform: rotate(360deg); } }
@media(max-width:640px) { .stats-bar { padding: 0; } .stats-content { grid-template-columns: 1fr; gap: 10px; } .stats-main { gap: 8px; } .stats-main h2 { font-size: 21px; flex-basis: 100%; } .search-status { font-size: 11px; } }
@media(prefers-reduced-motion:reduce) { .search-loading-dot { animation: none; } }
.sort-options { display: flex; flex-wrap: wrap; gap: 8px; }
.sort-option { min-height: 40px; padding: 8px 18px; border: 1px solid var(--border-light); border-radius: 8px; background: #fff; color: var(--text-secondary); font: inherit; font-size: 13px; cursor: pointer; }
.sort-option:hover { border-color: var(--primary); }
.sort-option.active { border-color: #f5be9b; background: #fff0e6; color: #c74510; font-weight: 600; }
</style>
