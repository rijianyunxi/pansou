import { defineEventHandler, getQuery } from "h3";
import { getOrCreateHotSearchService } from "../core/services/hotSearchService";
import { positiveInteger } from "../core/services/adminQueryHelpers";
import { setNoStore } from "../utils/apiResponse";

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

export default defineEventHandler(async (event) => {
  setNoStore(event);
  try {
    const service = getOrCreateHotSearchService();
    // Clamp instead of trusting the query string: a malformed or repeated
    // `limit` used to reach the store as NaN and silently return nothing.
    const limit = positiveInteger(getQuery(event).limit, DEFAULT_LIMIT, MAX_LIMIT);
    return {
      code: 0,
      message: "success",
      data: { hotSearches: await service.getHotSearches(limit) },
    };
  } catch (error) {
    console.error("[GET /api/hot-searches] failed to load hot searches", error);
    return {
      code: -1,
      message: "获取热搜失败",
      data: { hotSearches: [] },
    };
  }
});
