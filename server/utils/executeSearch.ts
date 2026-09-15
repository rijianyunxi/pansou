import { getOrCreateSearchService } from "../core/services";
import { getOrCreateHotSearchService } from "../core/services/hotSearchService";
import type { SearchSourceUpdate } from "../core/types/models";
import { applySearchDefaults } from "./searchDefaults";
import { parseSearchRequest, parseUserChannelSearchRequest } from "./searchRequest";
import {
  hideSearchResponseDebugFields,
  hideSearchUpdateDebugFields,
} from "./searchResponseVisibility";

export interface PreparedSearch {
  kind: "system";
  request: ReturnType<typeof parseSearchRequest>;
  effective: ReturnType<typeof applySearchDefaults>;
}

export interface PreparedUserChannelSearch {
  kind: "user-channels";
  request: ReturnType<typeof parseUserChannelSearchRequest>;
}

export type PreparedSearchRequest = PreparedSearch | PreparedUserChannelSearch;

export function prepareSearch(raw: unknown): PreparedSearch {
  const request = parseSearchRequest(raw);
  return {
    kind: "system",
    request,
    effective: applySearchDefaults(request),
  };
}

export function prepareUserChannelSearch(raw: unknown): PreparedUserChannelSearch {
  return {
    kind: "user-channels",
    request: parseUserChannelSearchRequest(raw),
  };
}

export async function executePreparedSearch(
  prepared: PreparedSearchRequest,
  signal?: AbortSignal,
  onSourceSuccess?: (update: SearchSourceUpdate) => void,
) {
  const service = getOrCreateSearchService(useRuntimeConfig());
  const sourceCallback = onSourceSuccess
    ? (update: SearchSourceUpdate) => {
        const debug = prepared.request.debug;
        onSourceSuccess(debug ? update : hideSearchUpdateDebugFields(update));
      }
    : undefined;

  const { response, warnings } = prepared.kind === "user-channels"
    ? await service.searchWithWarnings(
        prepared.request.kw,
        prepared.request.channels,
        prepared.request.conc,
        !!prepared.request.refresh,
        "tg",
        undefined,
        prepared.request.cloud_types,
        prepared.request.ext,
        { signal, onSourceSuccess: sourceCallback },
        "user",
      )
    : await service.searchWithWarnings(
        prepared.request.kw,
        prepared.effective.channels,
        prepared.effective.conc,
        !!prepared.request.refresh,
        prepared.effective.src,
        prepared.effective.plugins,
        prepared.request.cloud_types,
        prepared.effective.ext,
        { signal, onSourceSuccess: sourceCallback },
        "configured",
      );

  // 热搜记录由服务端统一处理，避免客户端额外发起一次 POST 请求。
  // 只记录本站搜索；自定义频道搜索仍保持原来的私有范围语义。
  if (prepared.kind === "system") {
    await getOrCreateHotSearchService().recordSearch(prepared.request.kw);
  }

  return {
    code: 0,
    message: warnings.length ? "partial_success" : "success",
    data: prepared.request.debug
      ? response
      : hideSearchResponseDebugFields(response),
    ...(prepared.request.debug && warnings.length ? { warnings } : {}),
  };
}
