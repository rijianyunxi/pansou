import type { SearchResponse } from "../core/types/models";

/** Removes diagnostic source metadata from the public streaming search response. */
export function hideSearchResponseDebugFields(response: SearchResponse): SearchResponse {
  const { meta: _meta, ...visible } = response;
  return visible;
}
