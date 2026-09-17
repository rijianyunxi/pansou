<template>
    <div v-if="searched" class="stats-bar">
      <div class="stats-content">
        <div class="stats-main">
          <span class="stat-item">
            <span class="stat-label">结果</span>
            <span class="stat-value">{{ total }}</span>
          </span>
          <span class="stat-item">
            <span class="stat-label">用时</span>
            <span class="stat-value">{{ elapsedMs }}ms</span>
          </span>
          <span v-if="paused" class="paused-indicator-bar">
            <span class="pause-icon">⏸</span>
            <span class="paused-text">搜索已暂停</span>
          </span>
        </div>

        <div class="platform-filters" v-if="hasResults">
          <button
            :class="['filter-pill', { active: filterPlatform === 'all' }]"
            :aria-pressed="filterPlatform === 'all'"
            @click="emit('update:filterPlatform', 'all')">
            全部
          </button>
          <button
            v-for="platform in platforms"
            :key="platform"
            :class="['filter-pill', { active: filterPlatform === platform }]"
            :aria-pressed="filterPlatform === platform"
            @click="emit('update:filterPlatform', platform)">
            {{ platformLabel(platform) }}
          </button>
        </div>

        <label v-if="hasResults" class="time-sort-select" title="按时间排序">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="12" cy="12" r="9"></circle>
            <path d="M12 7v5l3 2"></path>
          </svg>
          <span class="sort-label">按时间排序</span>
          <select :value="sortType" aria-label="选择时间排序方式" @change="onSortChange">
            <option value="default">默认顺序</option>
            <option value="date-desc">最新发布</option>
            <option value="date-asc">最早发布</option>
          </select>
        </label>
      </div>
    </div>

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
          :platform-label="platformLabel"
          @filter-platform="emit('filter-platform', $event)"
          @copy="emit('copy', $event)" />
      </div>
    </section>

    <section v-else-if="searched && !error && !loading && !paused" class="empty-state">
      <div class="empty-card">
        <div class="empty-icon">🔍</div>
        <h3>未找到相关资源</h3>
        <p>试试其他关键词，或检查设置中的搜索来源是否已开启</p>
      </div>
    </section>

    <section v-if="error" class="error-alert">
      <span class="error-icon">⚠️</span>
      <span>{{ error }}</span>
    </section>

    <div v-if="hasResults || showBackToTop" class="floating-tools" aria-label="页面工具">
      <button
        v-if="hasResults"
        class="floating-sort-button"
        type="button"
        aria-label="按时间排序，最新发布优先"
        title="按时间排序，最新发布优先"
        @click="emit('apply-time-sort')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <circle cx="12" cy="12" r="9"></circle>
          <path d="M12 7v5l3 2"></path>
        </svg>
      </button>
      <button
        v-if="showBackToTop"
        class="back-to-top"
        type="button"
        aria-label="回到顶部"
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
import type { SearchResult } from "~/server/core/types/models";

type SortType = "default" | "date-desc" | "date-asc";

interface Props {
  searched: boolean;
  total: number;
  elapsedMs: number;
  paused: boolean;
  loading: boolean;
  error: string;
  hasResults: boolean;
  platforms: string[];
  filterPlatform: string;
  sortType: SortType;
  filteredResults: SearchResult[];
  platformLabel: (type?: string) => string;
  showBackToTop: boolean;
}

defineProps<Props>();
const emit = defineEmits<{
  (event: "update:filterPlatform", value: string): void;
  (event: "update:sortType", value: SortType): void;
  (event: "filter-platform", value: string): void;
  (event: "copy", value: string): void;
  (event: "apply-time-sort"): void;
  (event: "scroll-to-top"): void;
}>();

function onSortChange(event: Event) {
  emit("update:sortType", (event.target as HTMLSelectElement).value as SortType);
}
</script>

<style scoped>
.stats-bar { background: var(--bg-primary); border: 1px solid var(--border-light); border-radius: var(--radius-lg); padding: 16px; box-shadow: var(--shadow-sm); animation: fadeIn 0.4s ease; }
.stats-content { display: flex; flex-direction: column; gap: 10px; }
.stats-main { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.stat-item { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--bg-secondary); border-radius: var(--radius-md); }
.stat-label { font-size: 13px; color: var(--text-tertiary); font-weight: 500; }
.stat-value { font-size: 18px; font-weight: 700; color: var(--text-primary); font-variant-numeric: tabular-nums; }
.paused-indicator-bar { display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; background: rgba(245, 158, 11, 0.1); border-radius: 999px; color: #b45309; font-weight: 500; }
.pause-icon { font-size: 14px; }
.paused-text { font-size: 13px; }
.platform-filters { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.filter-pill { position: relative; min-height: 32px; padding: 5px 12px; line-height: 20px; border: 1px solid var(--border-light); background: var(--bg-primary); border-radius: 8px; font-size: 13px; font-weight: 500; color: var(--text-secondary); cursor: pointer; transition: background-color var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast); white-space: nowrap; }
.filter-pill:focus-visible, .time-sort-select:focus-within { outline: 2px solid var(--primary); outline-offset: 3px; }
.filter-pill:hover { background: var(--bg-secondary); color: var(--text-primary); }
.filter-pill.active { background: var(--primary-soft); color: var(--primary); border-color: transparent; font-weight: 600; }
.time-sort-select { display: inline-flex; align-items: center; gap: 8px; width: fit-content; min-height: 40px; margin-top: 0; padding: 0 10px; border: 1px solid var(--border-light); border-radius: 12px; background: var(--bg-primary); color: var(--text-secondary); font-size: 13px; cursor: pointer; transition: border-color var(--transition-fast), background-color var(--transition-fast), color var(--transition-fast); }
.time-sort-select svg { width: 17px; height: 17px; flex: 0 0 auto; color: var(--primary); }
.time-sort-select select { min-width: 92px; min-height: 38px; padding: 0 18px 0 0; border: 0; outline: 0; background: transparent; color: var(--text-primary); font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; }
.time-sort-select:hover { border-color: var(--primary); background: var(--primary-soft); color: var(--text-primary); }
.floating-tools { position: fixed; right: 24px; bottom: max(24px, env(safe-area-inset-bottom)); z-index: 40; display: flex; flex-direction: column; gap: 8px; }
.floating-sort-button, .back-to-top { display: flex; align-items: center; justify-content: center; gap: 6px; width: 42px; height: 42px; min-height: 42px; padding: 0; border: 1px solid var(--border-light); border-radius: 12px; background: color-mix(in srgb, var(--bg-primary) 92%, transparent); color: var(--primary); box-shadow: var(--shadow-lg); backdrop-filter: blur(12px); font-size: 12px; font-weight: 700; cursor: pointer; transition: border-color var(--transition-fast), background-color var(--transition-fast), transform var(--transition-fast); }
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
  .time-sort-select { min-height: 44px; border-radius: 9px; }
  .time-sort-select select { min-height: 42px; }
  .sort-label { display: none; }
  .floating-tools { right: 14px; bottom: max(14px, env(safe-area-inset-bottom)); }
  .floating-sort-button, .back-to-top { width: 40px; height: 40px; min-height: 40px; }
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
</style>

