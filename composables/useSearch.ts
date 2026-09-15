import { computed, nextTick, ref } from "vue";
import type {
  GenericResponse,
  SearchResult,
  SearchResponse,
  SearchStreamResultData,
} from "../server/core/types/models";
import { consumeSearchEventStream } from "../utils/searchEventStream";

export interface SearchOptions {
  apiBase: string;
  keyword: string;
  userTgChannels?: string[];
  onlyUserTg?: boolean;
  onAuthRequired?: () => void;
}
export interface SearchState {
  loading: boolean;
  deepLoading: boolean;
  paused: boolean;
  error: string;
  warning: string;
  searched: boolean;
  elapsedMs: number;
  total: number;
  results: SearchResult[];
}

function mergeResource(current: SearchResult, incoming: SearchResult): SearchResult {
  const links = [...current.links];
  const seen = new Set(links.map((link) => `${link.type}\u0000${link.url}\u0000${link.password ?? ""}`));
  for (const link of incoming.links) {
    const key = `${link.type}\u0000${link.url}\u0000${link.password ?? ""}`;
    if (!seen.has(key)) { seen.add(key); links.push(link); }
  }
  return {
    ...current,
    ...incoming,
    links,
    cloud_types: [...new Set([...current.cloud_types, ...incoming.cloud_types])],
    description: incoming.description || current.description,
    datetime: incoming.datetime || current.datetime,
    tags: [...new Set([...(current.tags ?? []), ...(incoming.tags ?? [])])],
    images: [...new Set([...(current.images ?? []), ...(incoming.images ?? [])])],
  };
}

function mergeIncremental(current: SearchResult[], incoming: SearchResult[]): SearchResult[] {
  const byId = new Map(current.map((result) => [result.id, result]));
  for (const result of incoming) byId.set(result.id, byId.has(result.id) ? mergeResource(byId.get(result.id)!, result) : result);
  return [...byId.values()];
}

export function useSearch() {
  const initial = (): SearchState => ({ loading: false, deepLoading: false, paused: false,
    error: "", warning: "", searched: false, elapsedMs: 0, total: 0, results: [] });
  const state = ref<SearchState>(initial());
  let seq = 0;
  let controller: AbortController | undefined;
  let snapshot: SearchOptions | undefined;
  let started = 0;
  let accumulated = 0;

  function cancelActiveRequests() { seq++; controller?.abort(); controller = undefined; }
  function applyResponse(data: SearchResponse | undefined, replace: boolean) {
    const incoming = data?.results ?? [];
    state.value.results = replace ? incoming : mergeIncremental(state.value.results, incoming);
    state.value.total = state.value.results.length;
  }
  async function run(options: SearchOptions) {
    const mySeq = ++seq;
    const ac = new AbortController(); controller = ac; started = performance.now();
    state.value.loading = true; state.value.paused = false; state.value.error = "";
    let completed = false;
    try {
      const body: Record<string, unknown> = { kw: options.keyword.trim() };
      if (options.onlyUserTg) { body.channels = options.userTgChannels ?? []; body.channels_mode = "only"; }
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
        const payload = JSON.parse(event.data) as GenericResponse<unknown> & { warnings?: unknown[] };
        if (event.event === "result") {
          const update = (payload.data as SearchStreamResultData | undefined)?.update;
          if (update) { applyResponse({ total: update.results.length, results: update.results }, false); await nextTick(); }
        } else if (event.event === "complete") {
          if (payload.code !== 0) throw new Error(payload.message || "搜索失败");
          state.value.warning = payload.warnings?.length ? `部分来源未完成（${payload.warnings.length} 项告警），已展示成功来源的结果。` : "";
          completed = true;
        } else if (event.event === "error") throw new Error(payload.message || "搜索请求失败，请重试。");
      });
      if (!completed && mySeq === seq && !ac.signal.aborted) throw new Error("搜索流在完成事件前中断");
    } catch (error: any) {
      if (mySeq !== seq || ac.signal.aborted) return;
      const status = error?.statusCode ?? error?.status ?? error?.response?.status;
      state.value.error = status === 401 ? "请先解锁搜索，再重新搜索。" : error?.data?.statusMessage || error?.message || "搜索请求失败，请重试。";
      if (status === 401) options.onAuthRequired?.();
    } finally {
      if (mySeq === seq) { accumulated += performance.now() - started; state.value.elapsedMs = Math.round(accumulated); state.value.loading = false; state.value.deepLoading = false; controller = undefined; }
    }
  }
  async function performSearch(options: SearchOptions) {
    cancelActiveRequests(); state.value = initial(); snapshot = undefined; accumulated = 0;
    if (!options.keyword.trim()) { state.value.error = "请输入搜索关键词"; return; }
    if (options.onlyUserTg && !options.userTgChannels?.length) { state.value.error = "请先添加至少一个公开频道，再选择「自定义频道」搜索。"; return; }
    snapshot = { ...options, userTgChannels: [...(options.userTgChannels ?? [])] }; state.value.searched = true;
    if (typeof document !== "undefined" && document.activeElement instanceof HTMLInputElement) document.activeElement.blur(); await run(snapshot);
  }
  function pauseSearch() { if (!controller || state.value.paused) return; accumulated += performance.now() - started; state.value.elapsedMs = Math.round(accumulated); cancelActiveRequests(); state.value.paused = true; state.value.deepLoading = false; }
  async function continueSearch(_options?: SearchOptions) { if (!state.value.paused || !snapshot) return; await run(snapshot); }
  function resetSearch() { cancelActiveRequests(); snapshot = undefined; accumulated = 0; state.value = initial(); }
  async function copyLink(url: string) { try { await navigator.clipboard.writeText(url); } catch {} }
  return {
    state, loading: computed(() => state.value.loading), deepLoading: computed(() => state.value.deepLoading), paused: computed(() => state.value.paused), error: computed(() => state.value.error), searched: computed(() => state.value.searched), elapsedMs: computed(() => state.value.elapsedMs), total: computed(() => state.value.total), results: computed(() => state.value.results), hasResults: computed(() => state.value.results.length > 0),
    performSearch, resetSearch, copyLink, cancelActiveRequests, pauseSearch, continueSearch,
  };
}
