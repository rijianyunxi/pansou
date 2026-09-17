import { defineEventHandler, getQuery } from "h3";
import { getOrCreateSearchService } from "../core/services";
import { buildMonitorSources, type MonitorData } from "../utils/monitorSources";
import { requireAdminAuth } from "../utils/requireAdminAuth";

/**
 * GET /api/monitor —— every searchable object is returned as one unified
 * resource source, including channel-backed sources and, on request, the
 * archived ones the console recycle bin needs.
 */
export default defineEventHandler((event) => {
  requireAdminAuth(event);
  try {
    const includeDeleted = String(getQuery(event).includeDeleted || "") === "true";
    const service = getOrCreateSearchService();
    const healthById = Object.fromEntries(
      service.getSourceHealthStatus().map((status) => [status.id || status.name, status]),
    );

    return {
      code: 0,
      message: "success",
      data: {
        generatedAt: new Date().toISOString(),
        sources: buildMonitorSources(healthById, useRuntimeConfig(), includeDeleted),
      } satisfies MonitorData,
    };
  } catch (error) {
    console.error("[GET /api/monitor] failed to build monitor data", error);
    return { code: -1, message: "获取监控数据失败", data: null };
  }
});
