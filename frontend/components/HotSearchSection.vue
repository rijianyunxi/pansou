<template>
  <div v-if="!loading && searches.length === 0" class="hidden"></div>

  <div v-else class="hot-search-section">
    <div v-if="loading" class="loading-state">
      <div class="spinner"></div>
      <span>搜索热度加载中…</span>
    </div>

    <section v-else class="hot-search-panel" aria-label="热门搜索">
      <div class="hot-search-glow hot-search-glow--one" aria-hidden="true"></div>
      <div class="hot-search-glow hot-search-glow--two" aria-hidden="true"></div>

      <header class="hot-search-header">
        <div>
          <span class="hot-search-kicker">TRENDING / 现在热搜</span>
          <h2>热门搜索</h2>
          <p>从大家正在寻找的内容开始，发现下一站资源。</p>
        </div>
        <span class="hot-search-live"><i aria-hidden="true"></i> TRENDING</span>
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
            <strong>{{ truncateTerm(item.term) }}</strong>
            <small>{{ index === 0 ? "当前热词" : "热门关键词" }}</small>
          </span>
          <span class="hot-search-arrow" aria-hidden="true">↗</span>
          <span class="hot-search-spark" aria-hidden="true"><b :style="{ width: `${Math.min(100, 32 + index * 7)}%` }"></b></span>
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
const HOT_TERM_MAX_CHARS = 18;

function truncateTerm(term: string) {
  return term.length > HOT_TERM_MAX_CHARS ? `${term.slice(0, HOT_TERM_MAX_CHARS)}…` : term;
}

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

.hot-search-panel {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  padding: 26px 28px 18px;
  border: 1px solid rgba(117, 140, 255, 0.3);
  border-radius: 24px;
  background:
    radial-gradient(circle at 8% 0%, rgba(104, 125, 255, 0.16), transparent 34%),
    linear-gradient(145deg, #ffffff 0%, #f8faff 55%, #f4f6ff 100%);
  box-shadow: 0 18px 48px rgba(52, 92, 255, 0.1), inset 0 1px 0 rgba(255,255,255,.9);
}

.hot-search-header {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 21px;
}

.hot-search-kicker {
  display: block;
  margin-bottom: 8px;
  color: #536cf0;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 1.6px;
}

.hot-search-header h2 {
  margin: 0;
  color: var(--text-primary);
  font-size: 22px;
  font-weight: 800;
  letter-spacing: -0.04em;
}

.hot-search-header p {
  margin: 7px 0 0;
  color: var(--text-tertiary);
  font-size: 12px;
}

.hot-search-live {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 10px;
  border: 1px solid rgba(52, 92, 255, 0.2);
  border-radius: 999px;
  color: #536cf0;
  background: rgba(255,255,255,.72);
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 1px;
}

.hot-search-live i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #6cdbad;
  box-shadow: 0 0 0 4px rgba(108, 219, 173, .16), 0 0 14px rgba(108, 219, 173, .8);
}

.hot-search-grid {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.hot-search-item {
  position: relative;
  min-width: 0;
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) 22px;
  grid-template-rows: auto 4px;
  column-gap: 10px;
  row-gap: 11px;
  padding: 14px 15px 12px;
  overflow: hidden;
  border: 1px solid rgba(126, 143, 196, .2);
  border-radius: 14px;
  background: rgba(255,255,255,.74);
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
  transition: transform .2s ease, border-color .2s ease, box-shadow .2s ease, background .2s ease;
}

.hot-search-item:hover,
.hot-search-item:focus-visible {
  transform: translateY(-3px);
  border-color: rgba(52, 92, 255, .55);
  background: #fff;
  box-shadow: 0 9px 24px rgba(52, 92, 255, .15);
}

.hot-search-item:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.hot-search-item.featured { border-color: rgba(52, 92, 255, .5); background: linear-gradient(135deg, rgba(52, 92, 255, .11), rgba(255,255,255,.88)); }
.hot-search-rank { color: #7081de; font-size: 11px; font-weight: 800; letter-spacing: .6px; }
.hot-search-item-main { min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.hot-search-item-main strong { overflow: hidden; color: var(--text-primary); font-size: 13px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
.hot-search-item-main small { color: var(--text-tertiary); font-size: 10px; }
.hot-search-arrow { color: #7185ef; font-size: 19px; line-height: 1; text-align: right; }
.hot-search-spark { grid-column: 1 / -1; height: 4px; overflow: hidden; border-radius: 999px; background: rgba(52, 92, 255, .09); }
.hot-search-spark b { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #345cff, #a39dff); box-shadow: 0 0 10px rgba(52, 92, 255, .5); }
.hot-search-footer { position: relative; z-index: 1; display: flex; justify-content: space-between; gap: 12px; margin-top: 17px; color: var(--text-tertiary); font-size: 10px; }
.hot-search-glow { position: absolute; z-index: 0; width: 160px; height: 160px; border-radius: 50%; filter: blur(2px); pointer-events: none; }
.hot-search-glow--one { right: -55px; top: -72px; border: 1px solid rgba(125, 139, 255, .2); box-shadow: 0 0 0 18px rgba(125,139,255,.04), 0 0 0 38px rgba(125,139,255,.025); }
.hot-search-glow--two { left: -95px; bottom: -125px; border: 1px solid rgba(108,219,173,.18); box-shadow: 0 0 0 20px rgba(108,219,173,.04); }

.loading-state { display: flex; min-height: 220px; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--text-secondary); font-size: 12px; }
.spinner { width: 28px; height: 28px; border: 3px solid var(--border-light); border-top-color: var(--primary); border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

@media (max-width: 640px) {
  .hot-search-panel { padding: 21px 15px 15px; border-radius: 18px; }
  .hot-search-header { margin-bottom: 16px; }
  .hot-search-header h2 { font-size: 19px; }
  .hot-search-header p { max-width: 230px; line-height: 1.5; }
  .hot-search-grid { grid-template-columns: 1fr; gap: 8px; }
  .hot-search-footer { flex-direction: column; gap: 5px; }
}

@media (prefers-reduced-motion: reduce) {
  .hot-search-item { transition: none; }
  .spinner { animation: none; opacity: .7; }
}

.hidden { display: none; }
</style>
