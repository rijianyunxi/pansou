import {
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
  type Ref,
} from "vue";
import { apiFetch, apiErrorMessage } from "@/src/appRuntime";
/** Only mounted views poll; stale responses never replace newer channel/filter data. */
export function useCrawlQuery<T>(
  url: Ref<string>,
  params: Ref<Record<string, unknown>>,
  interval = 15000,
) {
  const data = shallowRef<T>(),
    loading = ref(true),
    error = ref(""),
    updatedAt = ref("");
  let controller: AbortController | undefined;
  let seq = 0,
    stopped = false,
    timer: ReturnType<typeof setInterval> | undefined;
  async function refresh() {
    if (stopped) return;
    const id = ++seq;
    controller?.abort();
    controller = new AbortController();
    loading.value = !data.value;
    try {
      const r = await apiFetch<{ data: T }>(url.value, {
        query: params.value,
        signal: controller.signal,
        silentError: true,
      });
      if (id !== seq) return;
      data.value = r.data;
      error.value = "";
      updatedAt.value = new Date().toLocaleTimeString("zh-CN", {
        hour12: false,
      });
    } catch (e) {
      if (id !== seq || (e as Error).name === "AbortError") return;
      error.value = apiErrorMessage(e);
      if ([401, 403].includes((e as { status?: number }).status || 0)) {
        stopped = true;
        if (timer) clearInterval(timer);
      }
    } finally {
      if (id === seq) loading.value = false;
    }
  }
  watch([url, params], () => {
    data.value = undefined;
    void refresh();
  });
  onMounted(() => {
    void refresh();
    if (interval > 0)
      timer = setInterval(() => {
        if (!document.hidden && !loading.value) void refresh();
      }, interval);
  });
  onBeforeUnmount(() => {
    stopped = true;
    seq++;
    controller?.abort();
    if (timer) clearInterval(timer);
  });
  return { data, loading, error, updatedAt, refresh };
}
