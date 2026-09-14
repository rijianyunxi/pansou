import { createEventStream, setHeader, type H3Event } from "h3";
import type { SearchLease } from "../core/security/concurrency";
import type { GenericResponse, SearchResponse, SearchStreamResultData } from "../core/types/models";
import { executePreparedSearch, type PreparedSearch } from "./executeSearch";
import { withRequestSignal } from "./requestSignal";
import { SEARCH_SSE_INTERVAL_MS, SearchSseQueue } from "./searchSseQueue";

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "搜索过程中发生未知错误";
}

/** Starts a pure SSE search response. Validation and admission must run first. */
export function sendSearchStream(
  event: H3Event,
  prepared: PreparedSearch,
  lease: SearchLease,
): Promise<void> {
  setHeader(event, "Cache-Control", "private, no-store, no-transform");
  setHeader(event, "X-Accel-Buffering", "no");
  const stream = createEventStream(event, { autoclose: false });
  let eventId = 0;
  const push = (name: string, payload: unknown) => stream.push({
    id: String(++eventId),
    event: name,
    data: JSON.stringify(payload),
  });
  const queue = new SearchSseQueue((update) => push("result", {
    code: 0,
    message: "source_success",
    data: { update },
  } satisfies GenericResponse<SearchStreamResultData>));

  void withRequestSignal(event, async (signal) => {
    await push("start", {
      code: 0,
      message: "started",
      data: { intervalMs: SEARCH_SSE_INTERVAL_MS },
    });
    const response = await executePreparedSearch(prepared, signal, (update) => queue.enqueue(update));
    await queue.finish();
    await push("complete", response satisfies GenericResponse<SearchResponse> & { warnings?: unknown[] });
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

  return stream.send();
}
