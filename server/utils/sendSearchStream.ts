import { createEventStream, setHeader, type H3Event } from "h3";
import type { SearchSourceUpdate, SearchStreamCompleteData, SearchStreamResultData } from "../core/types/models";
import { executePreparedSearch, type PreparedSearch } from "./executeSearch";
import { linkIdentity } from "../core/utils/resultMerge";
import { withRequestSignal } from "./requestSignal";
import { SEARCH_SSE_INTERVAL_MS, SearchSseQueue } from "./searchSseQueue";
import { logSearchStreamEvent } from "../core/utils/sourceDebug";

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "搜索过程中发生未知错误";
}

/**
 * Remove duplicate links that occur inside one source update. Cross-update
 * merging is handled by the shared link-only merge algorithm on the client and
 * in the final response; result ids are intentionally not consulted.
 */
function createDeltaFilter(): (update: SearchSourceUpdate) => SearchSourceUpdate {
  return (update) => ({
    ...update,
    results: update.results.flatMap((result) => {
      const seen = new Set<string>();
      const freshLinks = result.links.filter((link) => {
        const key = linkIdentity(link);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (!freshLinks.length) return [];
      return [{
        ...result,
        links: freshLinks,
        cloud_types: [...new Set(freshLinks.map((link) => link.type))],
      }];
    }),
  });
}

/** Starts a pure SSE search response. Validation and authorization must run first. */
export function sendSearchStream(
  event: H3Event,
  prepared: PreparedSearch,
): Promise<void> {
  setHeader(event, "Content-Type", "text/event-stream; charset=utf-8");
  setHeader(event, "Cache-Control", "private, no-store, no-transform");
  setHeader(event, "X-Accel-Buffering", "no");
  event.node.res.socket?.setNoDelay(true);

  const stream = createEventStream(event, { autoclose: false });
  let eventId = 0;
  const push = (name: string, payload: unknown) => {
    logSearchStreamEvent(name, payload);
    return stream.push({
      id: String(++eventId),
      event: name,
      data: JSON.stringify(payload),
    });
  };
  const filterDelta = createDeltaFilter();
  const queue = new SearchSseQueue((update) => {
    const delta = filterDelta(update);
    // Source identity stays server-side; clients merge batches by links alone.
    return push("result", { results: delta.results } satisfies SearchStreamResultData);
  });

  // Attach the readable side before producing events so every push is flushed as
  // soon as it is written instead of waiting behind TransformStream backpressure.
  const sending = stream.send();
  event.node.res.flushHeaders?.();

  void withRequestSignal(event, async (signal) => {
    await push("start", { intervalMs: SEARCH_SSE_INTERVAL_MS, searchLogId: prepared.searchLogId ?? null });
    const response = await executePreparedSearch(prepared, signal, (update) => queue.enqueueAndWait(update));
    await queue.finish();
    const completeData: SearchStreamCompleteData = {
      total: response.data?.total ?? 0,
    };
    await push("complete", completeData);
  }).catch(async (error) => {
    if (event.node.res.destroyed || event.node.res.writableEnded) return;
    try {
      await push("error", { message: errorMessage(error) });
    } catch {
      // The transport has already gone away.
    }
  }).finally(async () => {
    queue.cancel();
    try {
      await stream.close();
    } catch {
      // Closing an already disconnected stream is harmless.
    }
  });

  return sending;
}
