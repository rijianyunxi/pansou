import { defineEventHandler } from "h3";
import { getOrCreateSearchService } from "../core/services";
import { buildMonitorSources, type MonitorData } from "../utils/monitorSources";
import { requireAdminAuth } from "../utils/requireAdminAuth";

/**
 * GET /api/monitor —— every searchable object is returned as one unified
 * resource source from the source catalogue.
 */
export default defineEventHandler((event) => {
  requireAdminAuth(event);
  try {
    const service = getOrCreateSearchService();
    const healthById = Object.fromEntries(
      service.getSourceHealthStatus().map((status) => [status.id || status.name, status]),
    );

    return {
      code: 0,
      message: "success",
      data: {
        generatedAt: new Date().toISOString(),
        sources: buildMonitorSources(healthById),
      } satisfies MonitorData,
    };
  } catch (error) {
    console.error("[GET /api/monitor] failed to build monitor data", error);
    return { code: -1, message: "获取监控数据失败", data: null };
  }
});
