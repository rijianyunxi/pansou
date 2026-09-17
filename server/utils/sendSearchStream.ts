import { createEventStream, setHeader, type H3Event } from "h3";
import type {
  GenericResponse,
  SearchSourceUpdate,
  SearchStreamCompleteData,
  SearchStreamResultData,
} from "../core/types/models";
import { executePreparedSearch, type PreparedSearchRequest } from "./executeSearch";
import { withRequestSignal } from "./requestSignal";
import { SEARCH_SSE_INTERVAL_MS, SearchSseQueue } from "./searchSseQueue";
import { logSearchStreamEvent } from "../core/utils/upstreamDebug";

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "搜索过程中发生未知错误";
}

function searchResultKey(result: SearchSourceUpdate["results"][number]): string {
  return result.id;
}

function createDeltaFilter(): (update: SearchSourceUpdate) => SearchSourceUpdate {
  const sentLinks = new Map<string, Set<string>>();
  const sentLinkKeys = new Set<string>();
  return (update) => ({
    ...update,
    results: update.results.flatMap((result) => {
      const key = searchResultKey(result);
      const seen = sentLinks.get(key) ?? new Set<string>();
      const freshLinks = result.links.filter((link) => {
        const linkKey = `${link.type}\u0000${link.url}\u0000${link.password ?? ""}`;
        if (seen.has(linkKey) || sentLinkKeys.has(linkKey)) return false;
        seen.add(linkKey);
        sentLinkKeys.add(linkKey);
        return true;
      });
      sentLinks.set(key, seen);
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
  prepared: PreparedSearchRequest,
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
    const response = await executePreparedSearch(prepared, signal, (update) => queue.enqueueAndWait(update));
    await queue.finish();
    const completeData: SearchStreamCompleteData = {
      total: response.data?.total ?? 0,
    };
    await push("complete", {
      code: response.code,
      message: response.message,
      data: completeData,
    } satisfies GenericResponse<SearchStreamCompleteData>);
  }).catch(async (error) => {
    if (event.node.res.destroyed || event.node.res.writableEnded) return;
    try {
      await push("error", { code: -1, message: errorMessage(error) });
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
