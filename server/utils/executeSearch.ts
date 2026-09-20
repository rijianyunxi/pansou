import { getOrCreateSearchService } from "../core/services";
import { getOrCreateHotSearchService } from "../core/services/hotSearchService";
import { searchManagedResources } from "../core/services/managedResourceService";
import { buildUserSource, listUnifiedSources } from "../core/services/sourceCatalog";
import type { SearchDebugSource, SearchSourceUpdate } from "../core/types/models";
import { applySearchDefaults } from "./searchDefaults";
import { parseSearchRequest } from "./searchRequest";
import { mergeLocalResources } from "../core/utils/resultMerge";
import { completeSearchLog, failSearchLog } from "../core/services/searchAnalyticsService";

export interface PreparedSearch {
  request: ReturnType<typeof parseSearchRequest>;
  effective: ReturnType<typeof applySearchDefaults>;
  /** Internal response mode; never populated from a client request parameter. */
  includeDebug: boolean;
  /** Server-assigned id used to join search outcome and link interactions. */
  searchLogId?: number;
}

export function prepareSearch(raw: unknown, options: { includeDebug?: boolean } = {}): PreparedSearch {
  const request = parseSearchRequest(raw);
  return { request, effective: applySearchDefaults(request), includeDebug: options.includeDebug === true };
}

export async function executePreparedSearch(
  prepared: PreparedSearch,
  signal?: AbortSignal,
  onSourceSuccess?: (update: SearchSourceUpdate) => void | Promise<void>,
) {
  const service = getOrCreateSearchService();
  const configured = listUnifiedSources();
  // The presence of channels selects the user's custom-source mode. It never
  // mixes configured site sources; each stored user source is instantiated from
  // the shared source template. Without channels, search uses only the sources
  // selected in the site settings.
  const requestedChannels = prepared.request.channels;
  const customChannelMode = requestedChannels !== undefined;
  const selectedSourceIds = prepared.effective.sourceIds;
  const selected = customChannelMode
    ? []
    : selectedSourceIds === undefined
      ? configured
      : configured.filter((source) => selectedSourceIds.includes(source.id));
  const ephemeral = customChannelMode
    ? (requestedChannels ?? []).map((channel) => buildUserSource(channel))
    : [];

  // Local resources are an awaited phase before source execution. They are
  // site-level content rather than a member of the source catalogue, so an
  // explicit `sourceIds` selection does not exclude them. Custom-channel mode is
  // different: it is a request for "only these channels", and pinning
  // local resources on top of it would ignore the scope the caller asked for.
  const localResults = customChannelMode ? [] : searchManagedResources(prepared.request.kw);
  const sourceResultCounts: Record<string, number> = {};
  const sourceResults = new Map<string, SearchDebugSource["results"]>();
  const emitSourceSuccess = async (update: SearchSourceUpdate) => {
    sourceResultCounts[update.sourceId] = update.results.length;
    sourceResults.set(update.sourceId, update.results);
    await onSourceSuccess?.(update);
  };
  try {
    if (localResults.length) {
      await emitSourceSuccess({
        sourceId: "managed_resources",
        results: localResults,
      });
    }

    const { response, warnings } = await service.searchWithWarnings(
      prepared.request.kw,
      selected,
      prepared.effective.conc,
      !!prepared.request.refresh,
      { signal, onSourceSuccess: emitSourceSuccess },
      ephemeral,
    );
    // Keep the final JSON response and complete.total consistent with the
    // streamed view, while preserving local resources ahead of source data.
    response.results = mergeLocalResources(localResults, response.results);
    response.total = response.results.length;
    for (const source of response.sources || []) {
      if (source.status === "success") sourceResultCounts[source.id] = source.resultCount;
    }
    await getOrCreateHotSearchService().recordSearch(prepared.request.kw);
    if (prepared.searchLogId) completeSearchLog(prepared.searchLogId, response.total, sourceResultCounts);
    const sources = (response.sources || []).map((source) => ({
      ...source,
      results: sourceResults.get(source.id) || [],
    }));
    const data = prepared.includeDebug
      ? { total: response.total, sources, searchLogId: prepared.searchLogId }
      : { total: response.total, results: response.results, searchLogId: prepared.searchLogId };
    return {
      code: 0,
      message: warnings.length ? "partial_success" : "success",
      data,
    };
  } catch (error) {
    if (prepared.searchLogId) {
      try { failSearchLog(prepared.searchLogId); } catch { /* analytics must not mask the search error */ }
    }
    throw error;
  }
}
