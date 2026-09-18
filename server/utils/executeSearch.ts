import { getOrCreateSearchService } from "../core/services";
import { getOrCreateHotSearchService } from "../core/services/hotSearchService";
import { searchManagedResources } from "../core/services/managedResourceService";
import { buildUserSource, listUnifiedSources } from "../core/services/sourceCatalog";
import type { SearchSourceUpdate } from "../core/types/models";
import { hideSearchResponseDebugFields } from "./searchResponseVisibility";
import { applySearchDefaults } from "./searchDefaults";
import { parseSearchRequest } from "./searchRequest";
import { mergeLocalResources } from "../core/utils/resultMerge";

export interface PreparedSearch {
  request: ReturnType<typeof parseSearchRequest>;
  effective: ReturnType<typeof applySearchDefaults>;
  /** Internal response mode; never populated from a client request parameter. */
  includeMeta: boolean;
}

export function prepareSearch(raw: unknown, options: { includeMeta?: boolean } = {}): PreparedSearch {
  const request = parseSearchRequest(raw);
  return { request, effective: applySearchDefaults(request), includeMeta: options.includeMeta === true };
}

export async function executePreparedSearch(
  prepared: PreparedSearch,
  signal?: AbortSignal,
  onSourceSuccess?: (update: SearchSourceUpdate) => void | Promise<void>,
) {
  const service = getOrCreateSearchService();
  const configured = listUnifiedSources();
  // The presence of channels selects custom-channel mode. It never mixes
  // configured site sources; every requested channel is instantiated from the
  // persisted system channel source template. Without channels, search uses
  // only the sources selected in the site settings.
  const requestedChannels = prepared.request.channels;
  const customChannelMode = requestedChannels !== undefined;
  const selectedSourceIds = prepared.effective.sourceIds;
  const selected = customChannelMode
    ? []
    : selectedSourceIds?.length
      ? configured.filter((source) => selectedSourceIds.includes(source.id))
      : configured;
  const ephemeral = customChannelMode
    ? (requestedChannels ?? []).map((channel) => buildUserSource(channel))
    : [];

  // Local resources are an awaited phase before source execution. They are
  // site-level content rather than a member of the source catalogue, so an
  // explicit `sourceIds` selection does not exclude them. Custom-channel mode is
  // different: it is a request for "only these channels", and pinning
  // local resources on top of it would ignore the scope the caller asked for.
  const localResults = customChannelMode ? [] : searchManagedResources(prepared.request.kw);
  if (onSourceSuccess && localResults.length) {
    await onSourceSuccess({
      request: { keyword: prepared.request.kw, phase: "source" },
      results: localResults,
    });
  }

  const { response, warnings } = await service.searchWithWarnings(
    prepared.request.kw,
    selected,
    prepared.effective.conc,
    !!prepared.request.refresh,
    { signal, onSourceSuccess },
    ephemeral,
  );
  // Keep the final JSON response and complete.total consistent with the
  // streamed view, while preserving local resources ahead of source data.
  response.results = mergeLocalResources(localResults, response.results);
  response.total = response.results.length;
  await getOrCreateHotSearchService().recordSearch(prepared.request.kw);
  return {
    code: 0,
    message: warnings.length ? "partial_success" : "success",
    data: prepared.includeMeta ? response : hideSearchResponseDebugFields(response),
  };
}
