import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import type {
  SearchResult,
  SearchResponse,
  SearchStreamResultData,
} from "../server/core/types/models";
import { consumeSearchEventStream } from "../utils/searchEventStream";
import { mergeResultsByLink } from "../server/core/utils/resultMerge";

export interface SearchOptions {
  apiBase: string;
  keyword: string;
  userChannels?: string[];
  onlyUserChannels?: boolean;
  onSessionExpired?: () => void;
}
export interface SearchState {
  loading: boolean;
    paused: boolean;
  error: string;
  searched: boolean;
  elapsedMs: number;
  total: number;
  results: SearchResult[];
}

function mergeIncremental(current: SearchResult[], incoming: SearchResult[]): SearchResult[] {
  return mergeResultsByLink([...current, ...incoming]);
}

export function useSearch() {
  const initial = (): SearchState => ({ loading: false, paused: false,
    error: "", searched: false, elapsedMs: 0, total: 0, results: [] });
  const state = ref<SearchState>(initial());
  let seq = 0;
  let controller: AbortController | undefined;
  let snapshot: SearchOptions | undefined;
  let started = 0;
  let accumulated = 0;
  let elapsedTimer: ReturnType<typeof setInterval> | undefined;
  let searchLogId: number | undefined;

  function stopElapsedTimer() {
    if (elapsedTimer !== undefined) {
      clearInterval(elapsedTimer);
      elapsedTimer = undefined;
    }
  }

  function updateElapsed() {
    state.value.elapsedMs = Math.round(accumulated + performance.now() - started);
  }

  function cancelActiveRequests() {
    seq++;
    stopElapsedTimer();
    controller?.abort();
    controller = undefined;
  }
  function applyResponse(data: SearchResponse | undefined, replace: boolean) {
    const incoming = data?.results ?? [];
    state.value.results = replace ? incoming : mergeIncremental(state.value.results, incoming);
    state.value.total = state.value.results.length;
  }
  async function run(options: SearchOptions) {
    const mySeq = ++seq;
    stopElapsedTimer();
    const ac = new AbortController(); controller = ac; started = performance.now();
    state.value.loading = true; state.value.paused = false; state.value.error = "";
    searchLogId = undefined;
    updateElapsed();
    elapsedTimer = setInterval(() => {
      if (mySeq !== seq || ac.signal.aborted || !state.value.loading) return;
      updateElapsed();
    }, 100);
    let completed = false;
    try {
      const body: Record<string, unknown> = { kw: options.keyword.trim() };
      // All searches use one resource-source endpoint. User channels are
      // channels are sent only in custom-channel mode; otherwise the backend uses configured sources.
      if (options.onlyUserChannels) body.channels = options.userChannels ?? [];
      const response = await fetch(`${options.apiBase}/search`, { method: "POST", credentials: "include", signal: ac.signal,
        headers: { "Accept": "text/event-stream", "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) {
        const data = await response.json().catch(() => undefined) as { statusMessage?: string; message?: string } | undefined;
        const error = new Error(data?.statusMessage || data?.message || `搜索请求失败 (${response.status})`) as Error & { status?: number; data?: unknown };
        error.status = response.status; error.data = data; throw error;
      }
      if (!response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("搜索接口未返回 SSE 数据流");
      await consumeSearchEventStream(response, async (event) => {
        if (mySeq !== seq || ac.signal.aborted) return;
        const payload = JSON.parse(event.data) as { results?: SearchResult[]; total?: number; searchLogId?: unknown; message?: string };
        if (event.event === "start") {
          const id = Number(payload.searchLogId);
          searchLogId = Number.isSafeInteger(id) && id > 0 ? id : undefined;
        } else if (event.event === "result") {
          const update = payload as SearchStreamResultData;
          if (update.results) {
            applyResponse({ total: update.results.length, results: update.results }, false);
            await nextTick();
          }
        } else if (event.event === "complete") {
          completed = true;
        } else if (event.event === "error") throw new Error(payload.message || "搜索请求失败，请重试。");
      });
      if (!completed && mySeq === seq && !ac.signal.aborted) throw new Error("搜索流在完成事件前中断");
    } catch (error: any) {
      if (mySeq !== seq || ac.signal.aborted) return;
      const status = error?.statusCode ?? error?.status ?? error?.response?.status;
      if (status === 401) {
        state.value.error = "搜索会话已失效，请刷新页面后重试。此次请求未计入搜索配额。";
        options.onSessionExpired?.();
      } else if (status === 403) {
        // Prefer the server's reason: it distinguishes "sign in from the mini
        // program" from quota and channel problems.
        state.value.error = error?.data?.statusMessage || "当前账号无搜索权限（403）。请检查频道权限或联系管理员；拒绝请求不会计入搜索配额。";
      } else if (status === 429) {
        state.value.error = "搜索服务暂时不可用（429），请稍候再试。";
      } else {
        state.value.error = error?.data?.statusMessage || error?.message || "搜索请求失败，请重试。";
      }
    } finally {
      if (mySeq === seq) {
        stopElapsedTimer();
        accumulated += performance.now() - started;
        state.value.elapsedMs = Math.round(accumulated);
        state.value.loading = false;
        controller = undefined;
      }
    }
  }
  async function performSearch(options: SearchOptions) {
    cancelActiveRequests(); state.value = initial(); snapshot = undefined; searchLogId = undefined; accumulated = 0;
    if (!options.keyword.trim()) { state.value.error = "请输入搜索关键词"; return; }
    if (options.onlyUserChannels && !options.userChannels?.length) { state.value.error = "请先添加至少一个公开频道，再选择「自定义频道」搜索。"; return; }
    snapshot = { ...options, userChannels: [...(options.userChannels ?? [])] }; state.value.searched = true;
    if (typeof document !== "undefined" && document.activeElement instanceof HTMLInputElement) document.activeElement.blur(); await run(snapshot);
  }
  function pauseSearch() {
    if (!controller || state.value.paused) return;
    accumulated += performance.now() - started;
    state.value.elapsedMs = Math.round(accumulated);
    cancelActiveRequests();
    state.value.loading = false;
    state.value.paused = true;
  }
  async function continueSearch(_options?: SearchOptions) { if (!state.value.paused || !snapshot) return; await run(snapshot); }
  function resetSearch() { cancelActiveRequests(); snapshot = undefined; searchLogId = undefined; accumulated = 0; state.value = initial(); }
  // Leaving the home page should abort the SSE request immediately instead of
  // letting the server continue querying sources for an abandoned search.
  onBeforeUnmount(cancelActiveRequests);
  return {
    state, loading: computed(() => state.value.loading), paused: computed(() => state.value.paused), error: computed(() => state.value.error), searched: computed(() => state.value.searched), elapsedMs: computed(() => state.value.elapsedMs), total: computed(() => state.value.total), results: computed(() => state.value.results), hasResults: computed(() => state.value.results.length > 0),
    performSearch, resetSearch, cancelActiveRequests, pauseSearch, continueSearch,
  };
}
