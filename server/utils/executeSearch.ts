import { getOrCreateSearchService } from "../core/services";
import type { SearchSourceUpdate } from "../core/types/models";
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
  onSourceSuccess?: (update: SearchSourceUpdate) => void,
) {
  const { request, effective } = prepared;
  const service = getOrCreateSearchService(useRuntimeConfig());
  const sourceCallback = onSourceSuccess
    ? (update: SearchSourceUpdate) => onSourceSuccess(request.debug ? update : hideSearchUpdateDebugFields(update))
    : undefined;
  const { response, warnings } = await service.searchWithWarnings(
    request.kw,
    effective.channels,
    effective.conc,
    !!request.refresh,
    request.res,
    effective.src,
    effective.plugins,
    request.cloud_types,
    effective.ext,
    { signal, onSourceSuccess: sourceCallback },
  );
  return {
    code: 0,
    message: warnings.length ? "partial_success" : "success",
    data: request.debug ? response : hideSearchResponseDebugFields(response),
    ...(request.debug && warnings.length ? { warnings } : {}),
  };
}
