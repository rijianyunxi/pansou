import { createEventStream, setHeader, type H3Event } from "h3";
import type { SearchLease } from "../core/security/concurrency";
import type {
  GenericResponse,
  SearchResult,
  SearchSourceUpdate,
  SearchStreamCompleteData,
  SearchStreamResultData,
} from "../core/types/models";
import { executePreparedSearch, type PreparedSearch } from "./executeSearch";
import { withRequestSignal } from "./requestSignal";
import { SEARCH_SSE_INTERVAL_MS, SearchSseQueue } from "./searchSseQueue";

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "搜索过程中发生未知错误";
}

function searchResultKey(result: SearchResult): string {
  return result.unique_id
    || result.message_id
    || result.links?.[0]?.url
    || `${result.title}|${result.channel}|${result.datetime}`;
}

function createDeltaFilter(): (update: SearchSourceUpdate) => SearchSourceUpdate {
  const sent = new Set<string>();
  return (update) => ({
    ...update,
    results: update.results.filter((result) => {
      const key = searchResultKey(result);
      if (sent.has(key)) return false;
      sent.add(key);
      return true;
    }),
  });
}

/** Starts a pure SSE search response. Validation and admission must run first. */
export function sendSearchStream(
  event: H3Event,
  prepared: PreparedSearch,
  lease: SearchLease,
): Promise<void> {
  setHeader(event, "Content-Type", "text/event-stream; charset=utf-8");
  setHeader(event, "Cache-Control", "private, no-store, no-transform");
  setHeader(event, "X-Accel-Buffering", "no");
  event.node.res.socket?.setNoDelay(true);

  const stream = createEventStream(event, { autoclose: false });
  let eventId = 0;
  const push = (name: string, payload: unknown) => stream.push({
    id: String(++eventId),
    event: name,
    data: JSON.stringify(payload),
  });
  const filterDelta = createDeltaFilter();
  const queue = new SearchSseQueue((update) => push("result", {
    code: 0,
    message: "source_success",
    data: { update: filterDelta(update) },
  } satisfies GenericResponse<SearchStreamResultData>));

  // Attach the readable side before producing events so every push is flushed as
  // soon as it is written instead of waiting behind TransformStream backpressure.
  const sending = stream.send();
  event.node.res.flushHeaders?.();

  void withRequestSignal(event, async (signal) => {
    await push("start", {
      code: 0,
      message: "started",
      data: { intervalMs: SEARCH_SSE_INTERVAL_MS },
    });
    const response = await executePreparedSearch(prepared, signal, (update) => queue.enqueue(update));
    await queue.finish();
    const completeData: SearchStreamCompleteData = {
      total: response.data?.total ?? 0,
      ...(response.data?.meta ? { meta: response.data.meta } : {}),
    };
    await push("complete", {
      code: response.code,
      message: response.message,
      data: completeData,
      ...(response.warnings ? { warnings: response.warnings } : {}),
    } satisfies GenericResponse<SearchStreamCompleteData> & { warnings?: unknown[] });
  }).catch(async (error) => {
    if (event.node.res.destroyed || event.node.res.writableEnded) return;
    try {
      await push("error", { code: -1, message: errorMessage(error) });
    } catch {
      // The transport has already gone away.
    }
  }).finally(async () => {
    queue.cancel();
    lease.release();
    try {
      await stream.close();
    } catch {
      // Closing an already disconnected stream is harmless.
    }
  });

  return sending;
}
