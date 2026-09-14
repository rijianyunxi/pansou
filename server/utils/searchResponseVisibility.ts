import type { NormalizedSearchResult, NormalizedSearchSourceUpdate, SearchResponse } from "../core/types/models";

function hideItemDebugFields(item: NormalizedSearchResult): NormalizedSearchResult {
  const visible = { ...item };
  delete visible.source;
  delete visible.channel;
  delete visible.pluginId;
  delete visible.pluginVersion;
  delete visible.registryVersion;
  return visible;
}

/** Removes provenance/version diagnostics from the public response by default. */
export function hideSearchResponseDebugFields(response: SearchResponse): SearchResponse {
  const { meta: _meta, ...visible } = response;
  return { ...visible, results: response.results.map(hideItemDebugFields) };
}

/** Hides the SSE source envelope and debug fields on result records by default. */
export function hideSearchUpdateDebugFields(update: NormalizedSearchSourceUpdate): NormalizedSearchSourceUpdate {
  const { source: _source, ...visible } = update;
  return {
    ...visible,
    results: update.results.map((item) => hideItemDebugFields(item)),
  };
}
