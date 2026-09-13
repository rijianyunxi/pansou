import { getOrCreateSearchService } from "../core/services";
import { applySearchDefaults } from "./searchDefaults";
import { parseSearchRequest } from "./searchRequest";

/** Both routes must resolve scope identically; never let an empty list broaden scope. */
export async function executeSearch(raw: unknown, signal?: AbortSignal) {
  const req = parseSearchRequest(raw);
  const effective = applySearchDefaults({ ...req, channelsMode: req.channels_mode });
  const service = getOrCreateSearchService(useRuntimeConfig());
  const { response, warnings } = await service.searchWithWarnings(
    req.kw, effective.channels, effective.conc, !!req.refresh, req.res,
    effective.src, effective.plugins, req.cloud_types, effective.ext, { signal },
  );
  return {
    code: 0, message: warnings.length ? "partial_success" : "success", data: response,
    ...(warnings.length ? { warnings } : {}),
  };
}
