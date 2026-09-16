import { getOrCreateSearchService } from "../core/services";
import { getOrCreateHotSearchService } from "../core/services/hotSearchService";
import type { SearchSourceUpdate } from "../core/types/models";
import { applySearchDefaults } from "./searchDefaults";
import { parseSearchRequest } from "./searchRequest";
import { listUnifiedUpstreams, buildUserSource } from "../core/services/upstreamCatalog";
import { hideSearchResponseDebugFields } from "./searchResponseVisibility";

export interface PreparedSearch {
  request: ReturnType<typeof parseSearchRequest>;
  effective: ReturnType<typeof applySearchDefaults>;
  /** Internal response mode; never populated from a client request parameter. */
  includeMeta: boolean;
}
export type PreparedSearchRequest = PreparedSearch;

export function prepareSearch(raw: unknown, options: { includeMeta?: boolean } = {}): PreparedSearch {
  const request = parseSearchRequest(raw);
  return { request, effective: applySearchDefaults(request), includeMeta: options.includeMeta === true };
}

export async function executePreparedSearch(prepared: PreparedSearchRequest, signal?: AbortSignal, onSourceSuccess?: (update: SearchSourceUpdate) => void) {
  const service = getOrCreateSearchService(useRuntimeConfig());
  const sourceCallback = onSourceSuccess;
  const configured = listUnifiedUpstreams();
  // The presence of channels selects custom-channel mode. It never mixes
  // configured site sources; every requested channel is instantiated from the
  // persisted system Telegram source template. Without channels, search uses
  // only the sources selected in the site settings.
  const requestedChannels = prepared.request.channels;
  const customChannelMode = requestedChannels !== undefined;
  const selected = customChannelMode
    ? []
    : prepared.effective.sourceIds?.length
      ? configured.filter((source) => prepared.effective.sourceIds!.includes(source.id))
      : configured;
  const ephemeral = customChannelMode
    ? (requestedChannels ?? []).map((channel) => buildUserSource(channel))
    : [];
  const { response, warnings } = await service.searchWithWarnings(
    prepared.request.kw,
    selected,
    prepared.effective.conc,
    !!prepared.request.refresh,
    prepared.effective.ext,
    { signal, onSourceSuccess: sourceCallback },
    ephemeral,
  );
  await getOrCreateHotSearchService().recordSearch(prepared.request.kw);
  return {
    code: 0,
    message: warnings.length ? "partial_success" : "success",
    data: prepared.includeMeta ? response : hideSearchResponseDebugFields(response),
  };
}
