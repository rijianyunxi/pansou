import { defineEventHandler, readBody } from "h3";
import { getOrCreateHotSearchService } from "../core/services/hotSearchService";
import { setNoStore } from "../utils/apiResponse";

/** Matches the keyword bound enforced by the search APIs. */
const MAX_TERM_LENGTH = 100;

/**
 * 当前无调用方：2026-09-18 孤儿接口扫描确认，仓库内没有写入方。
 * 同路径的 GET /api/hot-searches 由 components/HotSearchSection.vue 使用，
 * 但本 POST（记录搜索词）无人调用。
 * 保留待定；若确认无用可直接删除本文件。
 */
export default defineEventHandler(async (event) => {
  setNoStore(event);
  try {
    const body = await readBody<{ term?: unknown }>(event);
    const term = typeof body?.term === "string" ? body.term.trim() : "";
    if (!term || term.length > MAX_TERM_LENGTH) {
      return {
        code: -1,
        message: "缺少搜索词参数",
        data: null,
      };
    }

    await getOrCreateHotSearchService().recordSearch(term);

    return {
      code: 0,
      message: "success",
      data: null,
    };
  } catch (error) {
    console.error("[POST /api/hot-searches] failed to record term", error);
    return {
      code: -1,
      message: "记录搜索词失败",
      data: null,
    };
  }
});
