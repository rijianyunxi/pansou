import type {
  SearchResponse,
  SearchResponseItem,
  SearchSourceUpdate,
} from "../core/types/models";

function hideItemDebugFields<T extends SearchResponseItem>(item: T): T {
  const {
    source: _source,
    pluginId: _pluginId,
    pluginVersion: _pluginVersion,
    ...visible
  } = item;
  return visible as T;
}

/** Removes provenance/version diagnostics from the public response by default. */
export function hideSearchResponseDebugFields(response: SearchResponse): SearchResponse {
  const { meta: _meta, ...visible } = response;
  return {
    ...visible,
    ...(response.results ? { results: response.results.map(hideItemDebugFields) } : {}),
    ...(response.items ? { items: response.items.map(hideItemDebugFields) } : {}),
  };
}

/** Keeps the SSE source envelope intact, but hides debug fields on result records. */
export function hideSearchUpdateDebugFields(update: SearchSourceUpdate): SearchSourceUpdate {
  return {
    ...update,
    results: update.results.map((item) => hideItemDebugFields(item)),
  };
}
