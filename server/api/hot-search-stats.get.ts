import { defineEventHandler } from "h3";
import { existsSync, statSync } from "node:fs";
import { getOrCreateHotSearchService } from "../core/services/hotSearchService";
import { getSqliteDatabase } from "../core/storage/sqlite";
import { setNoStore } from "../utils/apiResponse";

/**
 * Public hot-search storage metrics.
 *
 * The absolute database path is deliberately not returned: this endpoint is
 * unauthenticated, and the path would disclose the deployment layout. Size and
 * existence are enough for the metrics it exists to serve.
 *
 * 当前无调用方：2026-09-18 孤儿接口扫描确认，仓库内没有任何地方请求本路由
 * （只有 nuxt.config.ts 的 routeRules 里有一条缓存规则，那不是调用方）。
 * 保留待定；若确认无用可直接删除本文件。
 */
export default defineEventHandler(async (event) => {
  setNoStore(event);
  try {
    const service = getOrCreateHotSearchService();
    const stats = await service.getStats();
    const database = getSqliteDatabase();
    const isMemoryMode = database.path === ":memory:";
    const dbExists = !isMemoryMode && existsSync(database.path);
    const dbSizeBytes = dbExists ? statSync(database.path).size : 0;
    return {
      code: 0,
      message: "success",
      data: {
        stats,
        mode: service.getStoreType(),
        dbExists,
        dbSizeBytes,
        dbSizeMB: Number((dbSizeBytes / 1024 / 1024).toFixed(3)),
        isMemoryMode,
      },
    };
  } catch (error) {
    // A SQLite open failure embeds the file path in its message, so the detail
    // stays in the server log instead of the public response.
    console.error("[GET /api/hot-search-stats] failed to read stats", error);
    return {
      code: -1,
      message: "获取统计信息失败",
      data: null,
    };
  }
});
