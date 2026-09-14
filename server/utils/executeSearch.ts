import { getOrCreateSearchService } from "../core/services";
import type { NormalizedSearchSourceUpdate, SearchSourceUpdate } from "../core/types/models";
import { normalizeSearchResponse, normalizeSearchUpdate } from "../core/utils/searchResultNormalizer";
import { applySearchDefaults } from "./searchDefaults";
import { parseSearchRequest } from "./searchRequest";
import {
  hideSearchResponseDebugFields,
  hideSearchUpdateDebugFields,
} from "./searchResponseVisibility";

export interface PreparedSearch {
  request: ReturnType<typeof parseSearchRequest>;
  effective: ReturnType<typeof applySearchDefaults>;
}

export function prepareSearch(raw: unknown): PreparedSearch {
  const request = parseSearchRequest(raw);
  return {
    request,
    effective: applySearchDefaults({ ...request, channelsMode: request.channels_mode }),
  };
}

export async function executePreparedSearch(
  prepared: PreparedSearch,
  signal?: AbortSignal,
  onSourceSuccess?: (update: NormalizedSearchSourceUpdate) => void,
) {
  const { request, effective } = prepared;
  const service = getOrCreateSearchService(useRuntimeConfig());
  const sourceCallback = onSourceSuccess
    ? (update: SearchSourceUpdate) => {
        const normalized = normalizeSearchUpdate(update, request.debug, request.cloud_types);
        onSourceSuccess(request.debug ? normalized : hideSearchUpdateDebugFields(normalized));
      }
    : undefined;
  const { response, warnings } = await service.searchWithWarnings(
    request.kw,
    effective.channels,
    effective.conc,
    !!request.refresh,
    effective.src,
    effective.plugins,
    request.cloud_types,
    effective.ext,
    { signal, onSourceSuccess: sourceCallback },
  );
  const normalizedResponse = normalizeSearchResponse(response, request.debug, request.cloud_types);
  return {
    code: 0,
    message: warnings.length ? "partial_success" : "success",
    data: request.debug
      ? normalizedResponse
      : hideSearchResponseDebugFields(normalizedResponse),
    ...(request.debug && warnings.length ? { warnings } : {}),
  };
}
