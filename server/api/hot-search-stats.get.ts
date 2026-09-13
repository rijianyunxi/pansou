import { defineEventHandler } from "h3";
import { statSync, existsSync } from "node:fs";
import { getOrCreateHotSearchService } from "../core/services/hotSearchService";
import { getSqliteDatabase } from "../core/storage/sqlite";

export default defineEventHandler(async () => {
  try {
    const service = getOrCreateHotSearchService();
    const stats = await service.getStats();
    const database = getSqliteDatabase();
    const dbExists = database.path !== ":memory:" && existsSync(database.path);
    const dbSizeBytes = dbExists ? statSync(database.path).size : 0;
    return {
      code: 0,
      message: "success",
      data: {
        stats,
        mode: service.getStoreType(),
        dbExists,
        dbPath: database.path,
        dbSizeBytes,
        dbSizeMB: Number((dbSizeBytes / 1024 / 1024).toFixed(3)),
        isMemoryMode: database.path === ":memory:",
      },
    };
  } catch (error) {
    return {
      code: -1,
      message: "获取统计信息失败",
      data: { error: error instanceof Error ? error.message : String(error) },
    };
  }
});
