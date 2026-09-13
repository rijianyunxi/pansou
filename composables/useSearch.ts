import { computed, ref } from "vue";
import type { MergedLinks, GenericResponse, SearchResponse } from "../server/core/types/models";
import { extractMergedFromResponse } from "../utils/extractMergedFromResponse";

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
  merged: MergedLinks;
}

/** A single user request; system source expansion belongs exclusively to the server. */
export function useSearch() {
  const initial = (): SearchState => ({ loading: false, deepLoading: false, paused: false,
    error: "", warning: "", searched: false, elapsedMs: 0, total: 0, merged: {} });
  const state = ref<SearchState>(initial());
  let seq = 0;
  let controller: AbortController | undefined;
  let snapshot: SearchOptions | undefined;
  let started = 0;
  let accumulated = 0;

  function cancelActiveRequests() {
    seq++;
    controller?.abort();
    controller = undefined;
  }
  async function run(options: SearchOptions) {
    const mySeq = ++seq;
    const ac = new AbortController();
    controller = ac;
    started = performance.now();
    state.value.loading = true;
    state.value.paused = false;
    state.value.error = "";
    try {
      const body: Record<string, unknown> = { kw: options.keyword.trim() };
      // 本站搜索使用服务端默认来源，不注入空 channels 或 append 模式。
      // 只有“自定义频道”明确提交频道列表，并强制限定为 only。
      if (options.onlyUserTg) {
        body.channels = options.userTgChannels ?? [];
        body.channels_mode = "only";
      }
      const response = await $fetch<GenericResponse<SearchResponse> & { warnings?: unknown[] }>(
        `${options.apiBase}/search`, {
          method: "POST", credentials: "include", signal: ac.signal, retry: 0,
          body,
        },
      );
      if (mySeq !== seq) return;
      if (response.code !== 0) throw new Error(response.message || "搜索失败");
      state.value.merged = extractMergedFromResponse(response.data);
      state.value.total = Object.values(state.value.merged).reduce((sum, list) => sum + list.length, 0);
      state.value.warning = response.warnings?.length
        ? `部分来源未完成（${response.warnings.length} 项告警），已展示成功来源的结果。` : "";
    } catch (error: any) {
      if (mySeq !== seq || ac.signal.aborted) return;
      const status = error?.statusCode ?? error?.status ?? error?.response?.status;
      state.value.error = status === 401 ? "请先解锁搜索，再重新搜索。"
        : error?.data?.statusMessage || error?.message || "搜索请求失败，请重试。";
      if (status === 401) options.onAuthRequired?.();
    } finally {
      // Old requests must never reset the loading/results state of a newer search.
      if (mySeq === seq) {
        accumulated += performance.now() - started;
        state.value.elapsedMs = Math.round(accumulated);
        state.value.loading = false;
        state.value.deepLoading = false;
        controller = undefined;
      }
    }
  }
  async function performSearch(options: SearchOptions) {
    cancelActiveRequests();
    state.value = initial();
    snapshot = undefined;
    accumulated = 0;
    if (!options.keyword.trim()) { state.value.error = "请输入搜索关键词"; return; }
    if (options.onlyUserTg && !options.userTgChannels?.length) {
      state.value.error = "请先添加至少一个公开频道，再选择「自定义频道」搜索。";
      return;
    }
    snapshot = { ...options, userTgChannels: [...(options.userTgChannels ?? [])] };
    state.value.searched = true;
    if (typeof document !== "undefined" && document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    await run(snapshot);
  }
  function pauseSearch() {
    if (!controller || state.value.paused) return;
    accumulated += performance.now() - started;
    state.value.elapsedMs = Math.round(accumulated);
    cancelActiveRequests();
    state.value.paused = true;
    state.value.deepLoading = false;
  }
  async function continueSearch(_options?: SearchOptions) {
    // Non-streaming API has no server checkpoint: retry the original scope, never changed UI settings.
    if (!state.value.paused || !snapshot) return;
    await run(snapshot);
  }
  function resetSearch() {
    cancelActiveRequests();
    snapshot = undefined;
    accumulated = 0;
    state.value = initial();
  }
  async function copyLink(url: string) {
    try { await navigator.clipboard.writeText(url); } catch { /* Clipboard may be unavailable. */ }
  }
  return {
    state, loading: computed(() => state.value.loading), deepLoading: computed(() => state.value.deepLoading),
    paused: computed(() => state.value.paused), error: computed(() => state.value.error),
    searched: computed(() => state.value.searched), elapsedMs: computed(() => state.value.elapsedMs),
    total: computed(() => state.value.total), merged: computed(() => state.value.merged),
    hasResults: computed(() => Object.values(state.value.merged).some((items) => items.length > 0)),
    performSearch, resetSearch, copyLink, cancelActiveRequests, pauseSearch, continueSearch,
  };
}
