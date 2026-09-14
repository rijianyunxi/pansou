import { getOrCreateSearchService } from "../core/services";
import type { SearchSourceUpdate } from "../core/types/models";
import { applySearchDefaults } from "./searchDefaults";
import { parseSearchRequest } from "./searchRequest";

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
    { signal, onSourceSuccess },
  );
  return {
    code: 0,
    message: warnings.length ? "partial_success" : "success",
    data: response,
    ...(warnings.length ? { warnings } : {}),
  };
}
