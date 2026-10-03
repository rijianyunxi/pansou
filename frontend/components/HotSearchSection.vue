<template>
  <div v-if="!loading && searches.length === 0" class="hidden"></div>

  <div v-else class="hot-search-section">
    <div v-if="loading" class="loading-state">
      <div class="spinner"></div>
      <span>搜索热度加载中…</span>
    </div>

    <section v-else class="hot-search-panel" aria-label="热门搜索">
      <header class="hot-search-header">
        <div><h2><span aria-hidden="true">✳</span> 此刻，大家在找</h2><p>热门搜索 / TRENDING</p></div>
        <span class="hot-search-label">探索热门 <span aria-hidden="true">↗</span></span>
      </header>

      <div class="hot-search-grid">
        <button
          v-for="(item, index) in searches.slice(0, 10)"
          :key="item.term"
          type="button"
          class="hot-search-item"
          :class="{ featured: index === 0 }"
          @click="props.onSearch(item.term)">
          <span class="hot-search-rank">{{ String(index + 1).padStart(2, "0") }}</span>
          <span class="hot-search-item-main">
            <strong :title="item.term">{{ item.term }}</strong>
            <small v-if="index < 2">热门</small>
          </span>
          <span class="hot-search-arrow" aria-hidden="true">↗</span>
        </button>
      </div>

      <footer class="hot-search-footer">
        <span>点击词条，快速开始搜索</span>
        <span>{{ searches.length }} 个热搜词 · 热度随搜索更新</span>
      </footer>
    </section>
  </div>
</template>

<script setup lang="ts">
import { apiFetch, appConfig } from "../src/appRuntime";
import { ref } from "vue";


interface Props {
  onSearch: (term: string) => void;
}

interface HotSearchItem {
  term: string;
  score: number;
  pinned: boolean;
  status: string;
}

const props = defineProps<Props>();
const apiBase = appConfig.apiBase;
const loading = ref(false);
const searches = ref<HotSearchItem[]>([]);
const hasInitialized = ref(false);
let initialization: Promise<void> | undefined;
async function fetchHotSearches() {
  loading.value = true;
  try {
    const data = await apiFetch<{ code: number; data?: { hotSearches?: HotSearchItem[] } }>(
      `${apiBase}/hot-searches`,
      { query: { limit: 10 }, cache: "no-store" },
    );
    if (data.code === 0 && data.data?.hotSearches) {
      // The API orders pinned terms first, then score and last search time.
      searches.value = data.data.hotSearches.slice(0, 10);
      hasInitialized.value = true;
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
  if (initialization) return initialization;
  initialization = fetchHotSearches();
  try {
    await initialization;
  } finally {
    initialization = undefined;
  }
}


defineExpose({ init });
</script>

<style scoped>
.hot-search-section { width: 100%; }
.hot-search-panel { padding: 10px 12px 0; }
.hot-search-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.hot-search-header h2 { display: flex; align-items: center; gap: 9px; margin: 0; color: var(--text-primary); font-size: 24px; font-weight: 800; letter-spacing: -.04em; }
.hot-search-header h2 span { font-size: 30px; color: var(--primary); }
.hot-search-header p { margin: 3px 0 0 39px; font-size: 10px; letter-spacing: 1px; color: var(--text-tertiary); }
.hot-search-label { color: var(--text-secondary); font-size: 12px; }
.hot-search-label span { color: var(--primary); margin-left: 5px; }
.hot-search-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 7px 20px; }
.hot-search-item { display: flex; align-items: center; gap: 16px; min-width: 0; min-height: 40px; padding: 8px 16px; border: 1px solid transparent; border-radius: 8px; background: #faf4e9; text-align: left; cursor: pointer; transition: background .15s, border-color .15s; }
.hot-search-item:hover { background: #ffebd9; border-color: #ffc69e; }
.hot-search-item:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.hot-search-rank { width: 22px; flex-shrink: 0; color: var(--text-tertiary); font-size: 13px; font-variant-numeric: tabular-nums; }
.hot-search-item:nth-child(-n+3) .hot-search-rank { color: var(--primary); }
.hot-search-item-main { display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1; }
.hot-search-item-main strong { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 13px; font-weight: 600; color: var(--text-primary); }
.hot-search-item-main small { flex-shrink: 0; padding: 2px 7px; background: #ffe2ca; color: #cb4b0e; border-radius: 20px; font-size: 10px; }
.hot-search-arrow { color: var(--text-tertiary); font-size: 18px; }
.hot-search-footer { display: flex; justify-content: space-between; margin-top: 14px; color: var(--text-tertiary); font-size: 10px; }
.loading-state { min-height: 100px; display: flex; align-items: center; justify-content: center; gap: 10px; font-size: 12px; color: var(--text-secondary); }
.spinner { width: 20px; height: 20px; border: 2px solid var(--border-light); border-top-color: var(--primary); border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media(max-width:640px) { .hot-search-panel { padding: 8px 0 0; } .hot-search-header h2 { font-size: 21px; } .hot-search-label { display: none; } .hot-search-grid { gap: 7px 10px; } .hot-search-item { gap: 7px; padding: 9px; } .hot-search-item-main small { display: none; } .hot-search-footer { flex-wrap: wrap; gap: 5px; } }
@media(prefers-reduced-motion:reduce) { .spinner { animation: none; } .hot-search-item { transition: none; } }
.hidden { display: none; }
</style>
