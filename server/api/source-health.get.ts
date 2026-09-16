import { defineEventHandler } from "h3";
import { getOrCreateSearchService } from "../core/services";

export default defineEventHandler(() => {
  try {
    const service = getOrCreateSearchService(useRuntimeConfig());
    const sources = service.getSourceHealthStatus();
    return {
      code: 0,
      message: "success",
      data: {
        total: sources.length,
        healthy: sources.filter((source) => source.isHealthy).length,
        unhealthy: sources.filter((source) => !source.isHealthy).length,
        sources,
        cache: service.getCacheStats(),
      },
    };
  } catch {
    return { code: -1, message: "获取来源健康状态失败", data: null };
  }
});
